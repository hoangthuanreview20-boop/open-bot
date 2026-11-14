/**
 * MemoryV3View — memory v3 UI (v1.02, Team T2).
 *
 * Three sections on one screen, all local:
 *  - Block conflicts: pending contradictions between a memory block
 *    and incoming facts, with both sides' evidence (old line +
 *    block version, new fact + source + confidence) and three
 *    resolutions (keep current / accept new / merge by hand).
 *  - Temporal contradictions: pick two time windows (default: last
 *    week vs this week) and see what the user said in one window
 *    that contradicts the other, with timestamped evidence.
 *  - Block version history: pick a block label, see every past
 *    version, restore any version (it returns as a NEW version —
 *    history is never rewritten).
 *
 * Props follow the MemoryBlocksView pattern (bots + botId +
 * onSelectBot). Mounted inside MemoryView under the "Memory v3" tab.
 * Data flows over IPC `memory-v3:*` (no embeddings reach the
 * renderer).
 */
import { useEffect, useState } from 'react';
import { useT } from '../i18n/useT';
import type {
  BotConfigLike,
  MemoryV3BlockVersionView,
  MemoryV3ConflictView,
  MemoryV3ContradictionView,
} from '../types';

interface Props {
  bots: BotConfigLike[];
  botId: string | null;
  onSelectBot: (id: string) => void;
}

function isoDate(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export default function MemoryV3View({ bots, botId, onSelectBot }: Props) {
  const t = useT();
  const [conflicts, setConflicts] = useState<MemoryV3ConflictView[]>([]);
  const [mergedText, setMergedText] = useState<Record<string, string>>({});
  const [windowAFrom, setWindowAFrom] = useState(isoDate(14));
  const [windowATo, setWindowATo] = useState(isoDate(7));
  const [windowBFrom, setWindowBFrom] = useState(isoDate(7));
  const [windowBTo, setWindowBTo] = useState(isoDate(0));
  const [contradictions, setContradictions] = useState<MemoryV3ContradictionView[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [blockLabel, setBlockLabel] = useState('human');
  const [versions, setVersions] = useState<MemoryV3BlockVersionView[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const activeBot = bots.find((b) => b.id === botId) ?? bots[0] ?? null;

  const loadConflicts = async (id: string | null) => {
    if (!id) {
      setConflicts([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const list = await window.openBot.listMemoryV3Conflicts({ botId: id, action: 'list' });
      setConflicts(Array.isArray(list) ? list : [list]);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memory.v3.loadError'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadConflicts(activeBot?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBot?.id]);

  const resolve = async (conflict: MemoryV3ConflictView, resolution: 'keep-current' | 'accept-new' | 'merged') => {
    if (!activeBot) return;
    setError('');
    setNotice('');
    try {
      const text = mergedText[conflict.id] ?? '';
      if (resolution === 'merged' && text.trim() === '') {
        setError(t('memory.v3.mergeNeedsText'));
        return;
      }
      const resolved = await window.openBot.listMemoryV3Conflicts({
        botId: activeBot.id,
        action: 'resolve',
        conflictId: conflict.id,
        resolution,
        ...(resolution === 'merged' ? { resolvedText: text.trim() } : {}),
      });
      const done = Array.isArray(resolved) ? null : resolved;
      if (done) {
        setConflicts((prev) => prev.map((c) => (c.id === done.id ? done : c)));
        setNotice(t('memory.v3.resolvedOk'));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memory.v3.resolveError'));
    }
  };

  const searchContradictions = async () => {
    if (!activeBot) return;
    setSearching(true);
    setError('');
    setNotice('');
    try {
      const found = await window.openBot.findMemoryV3Contradictions({
        botId: activeBot.id,
        windowAFrom: `${windowAFrom}T00:00:00.000Z`,
        windowATo: `${windowATo}T00:00:00.000Z`,
        windowBFrom: `${windowBFrom}T00:00:00.000Z`,
        windowBTo: `${windowBTo}T00:00:00.000Z`,
      });
      setContradictions(found);
      if (found.length === 0) setNotice(t('memory.v3.noContradictions'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memory.v3.loadError'));
    } finally {
      setSearching(false);
    }
  };

  const loadHistory = async () => {
    if (!activeBot || blockLabel.trim() === '') return;
    setError('');
    setNotice('');
    try {
      const list = await window.openBot.getMemoryV3BlockHistory({
        botId: activeBot.id,
        action: 'list',
        block: blockLabel.trim(),
      });
      setVersions(Array.isArray(list) ? list : []);
      if (Array.isArray(list) && list.length === 0) setNotice(t('memory.v3.noVersions'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memory.v3.loadError'));
    }
  };

  const restore = async (version: MemoryV3BlockVersionView) => {
    if (!activeBot) return;
    setError('');
    setNotice('');
    try {
      await window.openBot.getMemoryV3BlockHistory({
        botId: activeBot.id,
        action: 'restore',
        block: version.label,
        version: version.version,
      });
      setNotice(t('memory.v3.restoredOk'));
      await loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memory.v3.restoreError'));
    }
  };

  const pending = conflicts.filter((c) => c.status === 'pending');

  return (
    <div data-testid="memory-v3-view">
      <div className="row">
        <label>
          {t('memory.bot')}
          <select value={activeBot?.id ?? ''} onChange={(e) => onSelectBot(e.target.value)} data-testid="memory-v3-bot-select">
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {loading ? (
        <p className="hint">{t('memory.loading')}</p>
      ) : (
        <>
          {error !== '' && <p className="error">{error}</p>}
          {notice !== '' && <p className="hint">{notice}</p>}

          <h3>{t('memory.v3.conflictsTitle')}</h3>
          <p className="hint">{t('memory.v3.conflictsIntro')}</p>
          {pending.length === 0 ? (
            <p className="hint" data-testid="memory-v3-no-conflicts">
              {t('memory.v3.noConflicts')}
            </p>
          ) : (
            <ul data-testid="memory-v3-conflicts">
              {pending.map((c) => (
                <li key={c.id} data-testid={`memory-v3-conflict-${c.id}`}>
                  <div>
                    <strong>{c.label}</strong> · {c.predicate}
                  </div>
                  <div>
                    {t('memory.v3.oldSide')}: {c.oldSide.text} ({t('memory.v3.version')} {c.oldSide.blockVersion ?? '?'})
                  </div>
                  <div>
                    {t('memory.v3.newSide')}: {c.newSide.text}
                    {c.newSide.confidence !== undefined ? ` (${t('memory.confidence')} ${c.newSide.confidence.toFixed(2)})` : ''}
                    {c.newSide.at ? ` · ${c.newSide.at.slice(0, 10)}` : ''}
                  </div>
                  <div className="row">
                    <button className="btn secondary" data-testid={`memory-v3-keep-${c.id}`} onClick={() => void resolve(c, 'keep-current')}>
                      {t('memory.v3.keepCurrent')}
                    </button>
                    <button className="btn secondary" data-testid={`memory-v3-accept-${c.id}`} onClick={() => void resolve(c, 'accept-new')}>
                      {t('memory.v3.acceptNew')}
                    </button>
                    <input
                      value={mergedText[c.id] ?? ''}
                      onChange={(e) => setMergedText((prev) => ({ ...prev, [c.id]: e.target.value }))}
                      placeholder={t('memory.v3.mergedPlaceholder')}
                      data-testid={`memory-v3-merged-input-${c.id}`}
                    />
                    <button className="btn secondary" data-testid={`memory-v3-merge-${c.id}`} onClick={() => void resolve(c, 'merged')}>
                      {t('memory.v3.merge')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <h3>{t('memory.v3.contradictionsTitle')}</h3>
          <p className="hint">{t('memory.v3.contradictionsIntro')}</p>
          <div className="row" data-testid="memory-v3-contradictions">
            <label>
              {t('memory.v3.windowA')}
              <input type="date" value={windowAFrom} onChange={(e) => setWindowAFrom(e.target.value)} data-testid="memory-v3-window-a-from" />
              <input type="date" value={windowATo} onChange={(e) => setWindowATo(e.target.value)} data-testid="memory-v3-window-a-to" />
            </label>
            <label>
              {t('memory.v3.windowB')}
              <input type="date" value={windowBFrom} onChange={(e) => setWindowBFrom(e.target.value)} data-testid="memory-v3-window-b-from" />
              <input type="date" value={windowBTo} onChange={(e) => setWindowBTo(e.target.value)} data-testid="memory-v3-window-b-to" />
            </label>
            <button className="btn" onClick={() => void searchContradictions()} disabled={searching} data-testid="memory-v3-search-contradictions">
              {searching ? t('memory.loading') : t('memory.v3.searchContradictions')}
            </button>
          </div>
          {contradictions !== null && contradictions.length > 0 && (
            <ul>
              {contradictions.map((c, i) => (
                <li key={`${c.subjectName}-${c.predicate}-${i}`}>
                  <div>{c.summary}</div>
                  <div className="hint">
                    {t('memory.v3.evidence')}: “{c.earlier.sourceText}” [{c.earlier.at.slice(0, 10)}] — “{c.later.sourceText}” [{c.later.at.slice(0, 10)}]
                  </div>
                </li>
              ))}
            </ul>
          )}

          <h3>{t('memory.v3.historyTitle')}</h3>
          <p className="hint">{t('memory.v3.historyIntro')}</p>
          <div className="row" data-testid="memory-v3-block-history">
            <label>
              {t('memory.v3.blockLabel')}
              <input value={blockLabel} onChange={(e) => setBlockLabel(e.target.value)} data-testid="memory-v3-block-label" />
            </label>
            <button className="btn secondary" onClick={() => void loadHistory()} data-testid="memory-v3-load-history">
              {t('memory.v3.loadHistory')}
            </button>
          </div>
          {versions !== null && versions.length > 0 && (
            <ul>
              {versions.map((v) => (
                <li key={v.version}>
                  <strong>
                    {t('memory.v3.version')} {v.version}
                  </strong>{' '}
                  · {v.action} · {v.actor} · {v.at.slice(0, 19).replace('T', ' ')}
                  <div className="hint">{v.content}</div>
                  <button className="btn secondary" data-testid={`memory-v3-restore-${v.version}`} onClick={() => void restore(v)}>
                    {t('memory.v3.restore')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
