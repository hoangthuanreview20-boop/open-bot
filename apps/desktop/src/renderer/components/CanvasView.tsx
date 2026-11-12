import { useEffect, useState } from 'react';
import type {
  BotConfigLike,
  CanvasBlockView,
  CanvasDocumentView,
  CanvasSummaryView,
} from '../types';
import { useT } from '../i18n/useT';
import Markdown from './Markdown';

interface Props {
  bots: BotConfigLike[];
  botId: string | null;
  onBack: () => void;
  onSelectBot?: (botId: string) => void;
}

/**
 * CanvasView (v0.86c) — view one bot's canvases in the desktop UI.
 *
 * The data layer has existed since v0.6 (CanvasStore, the canvas_write /
 * canvas_list / canvas_read tools); until now there was no View to look
 * at a canvas, so canvases could only be read through chat. This view
 * lists the selected bot's canvases, opens one to view its blocks,
 * copies the content, opens the JSON file in the OS default editor,
 * and deletes.
 *
 * Content safety: an `html` block is only previewed through
 * <iframe sandbox=""> (no scripts, no forms, no same-origin) via
 * srcDoc — untrusted JS inside a canvas never runs. A `markdown`
 * block renders through Markdown (AST, no raw HTML injection). Every
 * other block type is shown as text / JSON, never executed.
 */

// First string-valued field of a block, in key priority order.
function blockText(block: CanvasBlockView, keys: string[]): string {
  for (const key of keys) {
    const value = block[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

// Readable text of one block, used by "Copy content".
function blockPlainText(block: CanvasBlockView): string {
  switch (block.type) {
    case 'html':
      return blockText(block, ['html', 'content', 'text']);
    case 'code':
      return blockText(block, ['code', 'text', 'content']);
    default:
      return blockText(block, ['text', 'content', 'code', 'html']);
  }
}

function CanvasBlock({ block }: { block: CanvasBlockView }) {
  const t = useT();
  switch (block.type) {
    case 'html': {
      const html = blockText(block, ['html', 'content', 'text']);
      if (!html) return <p>{t('canvas.noContent')}</p>;
      return (
        <iframe
          sandbox=""
          srcDoc={html}
          title={t('canvas.htmlPreview')}
          data-testid="canvas-html-preview"
          style={{ width: '100%', height: '50vh', border: '1px solid var(--border, #ccc)', background: '#fff' }}
        />
      );
    }
    case 'markdown': {
      const text = blockText(block, ['text', 'content']);
      if (!text) return <p>{t('canvas.noContent')}</p>;
      return <Markdown text={text} />;
    }
    case 'code': {
      const code = blockText(block, ['code', 'text', 'content']);
      const language = blockText(block, ['language', 'lang']);
      if (!code) return <p>{t('canvas.noContent')}</p>;
      return (
        <div>
          {language && <p><em>{language}</em></p>}
          <pre
            data-testid="canvas-code-block"
            style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '50vh', overflow: 'auto' }}
          >
            {code}
          </pre>
        </div>
      );
    }
    case 'text': {
      const text = blockText(block, ['text', 'content']);
      if (!text) return <p>{t('canvas.noContent')}</p>;
      return <p style={{ whiteSpace: 'pre-wrap' }}>{text}</p>;
    }
    default:
      return (
        <div>
          <p><em>{t('canvas.unknownBlock', { type: block.type })}</em></p>
          <pre
            data-testid="canvas-unknown-block"
            style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '50vh', overflow: 'auto' }}
          >
            {JSON.stringify(block, null, 2)}
          </pre>
        </div>
      );
  }
}

export default function CanvasView({ bots, botId, onBack, onSelectBot }: Props) {
  const t = useT();
  const [summaries, setSummaries] = useState<CanvasSummaryView[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [viewing, setViewing] = useState<CanvasDocumentView | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState('');

  // Bot being viewed: the one selected in App, defaulting to the first bot.
  const effectiveBotId = botId ?? bots[0]?.id ?? null;

  const load = async (id: string) => {
    setLoading(true);
    try {
      setSummaries(await window.openBot.listCanvases(id));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('canvas.loadError'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!effectiveBotId) {
      setLoading(false);
      setSummaries([]);
      return;
    }
    setViewing(null);
    setConfirmDeleteId('');
    void load(effectiveBotId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveBotId]);

  const openCanvas = async (id: string) => {
    if (!effectiveBotId) return;
    setViewLoading(true);
    setNotice('');
    try {
      setViewing(await window.openBot.getCanvas(effectiveBotId, id));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('canvas.readError'));
      setViewing(null);
    } finally {
      setViewLoading(false);
    }
  };

  const copyContent = async () => {
    if (!viewing) return;
    const text = viewing.blocks.map((b) => blockPlainText(b)).filter((s) => s !== '').join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      setNotice(t('canvas.copied'));
    } catch {
      setNotice(t('canvas.copyError'));
    }
  };

  const openInEditor = async () => {
    if (!effectiveBotId || !viewing) return;
    try {
      await window.openBot.openCanvasInEditor(effectiveBotId, viewing.id);
      setNotice('');
    } catch (e) {
      setNotice(e instanceof Error ? e.message : t('canvas.openInEditorError'));
    }
  };

  const deleteCanvas = async (id: string) => {
    if (!effectiveBotId) return;
    try {
      await window.openBot.deleteCanvas(effectiveBotId, id);
      setConfirmDeleteId('');
      if (viewing?.id === id) setViewing(null);
      setNotice(t('canvas.deleted'));
      await load(effectiveBotId);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('canvas.deleteError'));
    }
  };

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  return (
    <div className="panel">
      <button className="btn secondary" onClick={onBack}>{t('canvas.back')}</button>
      <h2>{t('canvas.title')}</h2>
      <p>{t('canvas.intro')}</p>
      {bots.length === 0 && <p>{t('canvas.noBots')}</p>}
      {bots.length > 0 && (
        <label>
          {t('canvas.selectBotLabel')}
          <select
            data-testid="canvas-bot-select"
            value={effectiveBotId ?? ''}
            onChange={(e) => onSelectBot?.(e.target.value)}
          >
            {bots.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </label>
      )}
      {loading && <p data-testid="canvas-loading">{t('canvas.loading')}</p>}
      {error && <p className="error">{error}</p>}
      {notice && <p>{notice}</p>}

      {!loading && !error && effectiveBotId && summaries.length === 0 && !viewing && (
        <p data-testid="canvas-empty">{t('canvas.empty')}</p>
      )}

      {!viewing && summaries.map((s) => (
        <section key={s.id} className="card" data-testid={`canvas-item-${s.id}`}>
          <h3>{s.title}</h3>
          <p>
            {t('canvas.blocks', { count: String(s.blockCount) })}
            {' · '}
            {t('canvas.version', { version: String(s.version) })}
            {' · '}
            {t('canvas.updatedAt', { date: formatDate(s.updatedAt) })}
          </p>
          <button
            className="btn secondary"
            data-testid={`canvas-open-${s.id}`}
            onClick={() => void openCanvas(s.id)}
          >
            {t('canvas.open')}
          </button>
          {confirmDeleteId === s.id ? (
            <>
              <button
                className="btn"
                data-testid={`canvas-delete-confirm-${s.id}`}
                onClick={() => void deleteCanvas(s.id)}
              >
                {t('canvas.deleteConfirm')}
              </button>
              <button className="btn secondary" onClick={() => setConfirmDeleteId('')}>
                {t('canvas.deleteCancel')}
              </button>
            </>
          ) : (
            <button
              className="btn secondary"
              data-testid={`canvas-delete-${s.id}`}
              onClick={() => setConfirmDeleteId(s.id)}
            >
              {t('canvas.delete')}
            </button>
          )}
        </section>
      ))}

      {viewLoading && <p>{t('canvas.loading')}</p>}
      {viewing && (
        <section className="card" data-testid="canvas-content">
          <h3>{viewing.title}</h3>
          <p>
            {t('canvas.blocks', { count: String(viewing.blocks.length) })}
            {' · '}
            {t('canvas.version', { version: String(viewing.version) })}
            {' · '}
            {t('canvas.updatedAt', { date: formatDate(viewing.updatedAt) })}
          </p>
          <button className="btn secondary" data-testid="canvas-copy" onClick={() => void copyContent()}>
            {t('canvas.copy')}
          </button>
          <button className="btn secondary" data-testid="canvas-open-editor" onClick={() => void openInEditor()}>
            {t('canvas.openInEditor')}
          </button>
          <button className="btn secondary" onClick={() => setViewing(null)}>
            {t('canvas.close')}
          </button>
          {viewing.blocks.length === 0 && <p>{t('canvas.empty')}</p>}
          {viewing.blocks.map((block, i) => (
            <div key={i} data-testid={`canvas-block-${i}`}>
              <CanvasBlock block={block} />
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
