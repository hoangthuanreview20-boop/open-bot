import { useEffect, useState } from 'react';
import type { AgentTemplateLike, BotConfigLike, PublishedAgentLike } from '../types';
import { useT } from '../i18n/useT';
import ConfirmModal, { type PendingConfirm } from './ConfirmModal';

interface Props {
  bots: BotConfigLike[];
  onBack: () => void;
  /** A new bot was created (from a template or a published entry). */
  onBotInstalled: (bot: BotConfigLike) => void;
}

export default function AgentMarketplaceView({ bots, onBack, onBotInstalled }: Props) {
  const t = useT();
  const [templates, setTemplates] = useState<AgentTemplateLike[]>([]);
  const [published, setPublished] = useState<PublishedAgentLike[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [publishBotId, setPublishBotId] = useState('');
  const [publishDescription, setPublishDescription] = useState('');
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  // v0.77 (UI parity §3.7): template / published entry being previewed
  // (full system prompt + tools) before install — the cards only show
  // the short description.
  const [preview, setPreview] = useState<
    | { kind: 'template'; tpl: AgentTemplateLike }
    | { kind: 'published'; entry: PublishedAgentLike }
    | null
  >(null);

  // Esc closes the preview (same pattern as ConfirmModal).
  useEffect(() => {
    if (!preview) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      setPreview(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [preview]);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [tpls, pubs] = await Promise.all([
        window.openBot.listTemplates(),
        window.openBot.listMarketplace(),
      ]);
      setTemplates(tpls);
      setPublished(pubs);
      if (bots.length > 0) setPublishBotId((prev) => prev || bots[0].id);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('marketplace.loadError'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // Load once on mount; bots are passed in as props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const useTemplate = async (tpl: AgentTemplateLike) => {
    setBusyId(`tpl:${tpl.id}`);
    setError('');
    setNotice('');
    try {
      const bot = await window.openBot.createBot({
        name: tpl.name,
        providerId: tpl.providerId ?? 'xai',
        model: tpl.model ?? '',
        systemPrompt: tpl.systemPrompt,
      });
      setNotice(t('marketplace.createdOk', { name: bot.name }));
      onBotInstalled(bot);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('marketplace.loadError'));
    } finally {
      setBusyId(null);
    }
  };

  const install = async (entry: PublishedAgentLike) => {
    setBusyId(`pub:${entry.id}`);
    setError('');
    setNotice('');
    try {
      const bot = await window.openBot.installMarketplace(entry.id);
      setNotice(t('marketplace.installedOk', { name: bot.name }));
      await load();
      onBotInstalled(bot);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('marketplace.loadError'));
    } finally {
      setBusyId(null);
    }
  };

  const uninstall = (entry: PublishedAgentLike) => {
    setPendingConfirm({
      title: t('marketplace.title'),
      message: t('marketplace.uninstallConfirm', { name: entry.name }),
      confirmLabel: t('marketplace.uninstall'),
      onConfirm: () => void doUninstall(entry),
    });
  };

  const doUninstall = async (entry: PublishedAgentLike) => {
    setBusyId(`pub:${entry.id}`);
    setError('');
    setNotice('');
    try {
      await window.openBot.uninstallMarketplace(entry.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('marketplace.loadError'));
    } finally {
      setBusyId(null);
    }
  };

  const publish = async () => {
    const bot = bots.find((b) => b.id === publishBotId);
    if (!bot) return;
    setBusyId('publish');
    setError('');
    setNotice('');
    try {
      const entry = await window.openBot.publishAgent(bot.id, {
        description: publishDescription.trim(),
      });
      setNotice(t('marketplace.publishOk', { name: entry.name }));
      setPublishDescription('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('marketplace.loadError'));
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <div className="panel">
        <p>{t('marketplace.loading')}</p>
      </div>
    );
  }

  return (
    <div className="panel">
      <button className="btn secondary" onClick={onBack}>{t('marketplace.back')}</button>
      <h2>{t('marketplace.title')}</h2>
      <p className="hint">{t('marketplace.localNote')}</p>
      {error && (
        <>
          <p className="error">{error}</p>
          {/* v0.71 (audit): the marketplace load had a loading line and
              an error but no retry — leaving the view was the only way
              to reload. */}
          <button className="btn secondary" data-testid="marketplace-retry" onClick={() => void load()}>
            {t('marketplace.retry')}
          </button>
        </>
      )}
      {notice && <p className="success">{notice}</p>}

      <section className="card">
        <h3>{t('marketplace.templatesTitle')}</h3>
        {templates.map((tpl) => (
          <div key={tpl.id} className="card">
            <h3>
              {tpl.name} <span className="badge">{t(`marketplace.category.${tpl.category}`)}</span>
            </h3>
            <p>{tpl.description}</p>
            <p className="hint">
              {t('marketplace.suggestedTools')} {tpl.suggestedTools.join(', ')}
            </p>
            <div className="row">
              <button
                className="btn secondary"
                onClick={() => setPreview({ kind: 'template', tpl })}
              >
                {t('marketplace.preview')}
              </button>
              <button
                className="btn"
                disabled={busyId === `tpl:${tpl.id}`}
                onClick={() => void useTemplate(tpl)}
              >
                {t('marketplace.useTemplate')}
              </button>
            </div>
          </div>
        ))}
      </section>

      <section className="card">
        <h3>{t('marketplace.publishedTitle')}</h3>
        {published.length === 0 && <p className="empty">{t('marketplace.emptyPublished')}</p>}
        {published.map((entry) => (
          <div key={entry.id} className="card">
            <h3>{entry.name}</h3>
            <p>{entry.description || entry.config.systemPrompt}</p>
            <p className="hint">
              {t('marketplace.author', { author: entry.author })} ·{' '}
              {t('marketplace.installs', { count: entry.installs })}
            </p>
            <div className="row">
              <button
                className="btn secondary"
                onClick={() => setPreview({ kind: 'published', entry })}
              >
                {t('marketplace.preview')}
              </button>
              <button
                className="btn"
                disabled={busyId === `pub:${entry.id}`}
                onClick={() => void install(entry)}
              >
                {t('marketplace.install')}
              </button>
              <button
                className="btn secondary"
                disabled={busyId === `pub:${entry.id}`}
                onClick={() => void uninstall(entry)}
              >
                {t('marketplace.uninstall')}
              </button>
            </div>
          </div>
        ))}
      </section>

      <section className="card">
        <h3>{t('marketplace.publishTitle')}</h3>
        <div className="field">
          <select value={publishBotId} onChange={(e) => setPublishBotId(e.target.value)}>
            {bots.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <input
            value={publishDescription}
            onChange={(e) => setPublishDescription(e.target.value)}
            placeholder={t('marketplace.publishDescriptionPlaceholder')}
          />
        </div>
        <button
          className="btn"
          disabled={!publishBotId || busyId === 'publish'}
          onClick={() => void publish()}
        >
          {t('marketplace.publishButton')}
        </button>
      </section>
      {preview && (
        <div className="modal-backdrop" onClick={() => setPreview(null)}>
          <div
            className="modal"
            role="dialog"
            aria-label={preview.kind === 'template' ? preview.tpl.name : preview.entry.name}
            data-testid="marketplace-preview"
            onClick={(e) => e.stopPropagation()}
          >
            <h2>{preview.kind === 'template' ? preview.tpl.name : preview.entry.name}</h2>
            <p>
              {preview.kind === 'template'
                ? preview.tpl.description
                : preview.entry.description || preview.entry.config.systemPrompt}
            </p>
            <p className="hint">
              {preview.kind === 'template'
                ? `${preview.tpl.providerId ?? 'xai'} · ${preview.tpl.model ?? ''}`
                : `${preview.entry.config.providerId} · ${preview.entry.config.model}`}
              {preview.kind === 'published' &&
                ` · ${t('marketplace.author', { author: preview.entry.author })} · ${t('marketplace.installs', { count: preview.entry.installs })}`}
            </p>
            {preview.kind === 'template' && preview.tpl.suggestedTools.length > 0 && (
              <p className="hint">
                {t('marketplace.suggestedTools')} {preview.tpl.suggestedTools.join(', ')}
              </p>
            )}
            <h3>{t('marketplace.previewSystemPrompt')}</h3>
            <pre style={{ whiteSpace: 'pre-wrap' }}>
              {preview.kind === 'template' ? preview.tpl.systemPrompt : preview.entry.config.systemPrompt}
            </pre>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="btn secondary" data-testid="marketplace-preview-close" onClick={() => setPreview(null)}>
                {t('marketplace.previewClose')}
              </button>
              <button
                className="btn"
                data-testid="marketplace-preview-action"
                disabled={
                  preview.kind === 'template'
                    ? busyId === `tpl:${preview.tpl.id}`
                    : busyId === `pub:${preview.entry.id}`
                }
                onClick={() => {
                  const p = preview;
                  setPreview(null);
                  if (p.kind === 'template') void useTemplate(p.tpl);
                  else void install(p.entry);
                }}
              >
                {preview.kind === 'template' ? t('marketplace.useTemplate') : t('marketplace.install')}
              </button>
            </div>
          </div>
        </div>
      )}
      {pendingConfirm && (
        <ConfirmModal
          title={pendingConfirm.title}
          message={pendingConfirm.message}
          confirmLabel={pendingConfirm.confirmLabel}
          onCancel={() => setPendingConfirm(null)}
          onConfirm={() => {
            const c = pendingConfirm;
            setPendingConfirm(null);
            c.onConfirm();
          }}
        />
      )}
    </div>
  );
}
