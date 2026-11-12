import { useEffect, useState } from 'react';
import type { AgentTemplateLike, BotConfigLike, ProviderRailView } from '../types';
import ModelPicker from './ModelPicker';
import { BOT_COLORS, botColor } from './botColors';
import { useT } from '../i18n/useT';

interface Props {
  initial: BotConfigLike | null; // null = create new
  onSave: (config: Partial<BotConfigLike> & { id?: string }) => Promise<void>;
  onCancel: () => void;
  /** Jump to Settings → Engines (passed by App; without it the rail still works, just without the link). */
  onOpenEngines?: () => void;
}

export default function BotForm({ initial, onSave, onCancel, onOpenEngines }: Props) {
  const t = useT();
  const [name, setName] = useState(initial?.name ?? '');
  // v0.77 (UI parity §3.3): short description — shown under the bot
  // name in the sidebar so bots are recognisable beyond name/model.
  const [description, setDescription] = useState(initial?.description ?? '');
  // v0.62 (UI-13): avatar colour — the stored value when valid, else
  // the default (an old/unknown value never renders a broken swatch).
  const [color, setColor] = useState(botColor(initial?.color));
  const [providerId, setProviderId] = useState(initial?.providerId ?? 'xai');
  const [model, setModel] = useState(initial?.model ?? '');
  // v0.90b (team G): sources disabled for this bot only (the global
  // opt-in in Settings → Engines is untouched). The picker below
  // hides them; disabling the running model's source shows a warning
  // + a suggested replacement there instead of switching silently.
  const [disabledProviders, setDisabledProviders] = useState<string[]>([
    ...(initial?.disabledProviders ?? []),
  ]);
  // Unfiltered rail for the per-bot sources checklist (the picker
  // itself loads the filtered rail through ModelPicker).
  const [sourcesRail, setSourcesRail] = useState<ProviderRailView | null>(null);
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? '');
  const [workspaceDir, setWorkspaceDir] = useState(initial?.workspaceDir ?? '');
  const [autoApprove, setAutoApprove] = useState(initial?.autoApprove ?? false);
  const [approvalLevel, setApprovalLevel] = useState<'ask-always' | 'ask-for-writes' | 'auto-approve-safe'>(
    initial?.approvalLevel ?? 'ask-for-writes',
  );
  const [templates, setTemplates] = useState<AgentTemplateLike[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Templates are only offered when creating a new bot.
  useEffect(() => {
    if (initial) return;
    window.openBot.listTemplates().then(setTemplates).catch(() => setTemplates([]));
  }, [initial]);

  // v0.90b: the sources checklist follows engine changes (a Re-detect
  // / toggle in Settings pushes a new snapshot, and the list follows
  // without reopening the form).
  useEffect(() => {
    const load = () => {
      // v0.90e (Team G): guard — the old v0.77 renderer-test mock
      // `openBot` has no listModelRail; calling it bare would throw a
      // TypeError inside the effect and crash the whole form (losing
      // the description field).
      if (typeof window.openBot.listModelRail !== 'function') return;
      window.openBot
        .listModelRail()
        .then(setSourcesRail)
        .catch(() => setSourcesRail(null));
    };
    load();
    if (typeof window.openBot.onEnginesChanged !== 'function') return undefined;
    return window.openBot.onEnginesChanged(() => load());
  }, []);

  /** Toggle one CLI source on/off straight from the rail. */
  const toggleEngine = async (kind: string, enabled: boolean) => {
    await window.openBot.setEngineEnabled({ kind, enabled });
  };

  /** Picking a template pre-fills provider, model and system prompt. */
  const applyTemplate = (id: string) => {
    setTemplateId(id);
    if (!id) return;
    const tpl = templates.find((x) => x.id === id);
    if (!tpl) return;
    setProviderId(tpl.providerId ?? 'xai');
    setModel(tpl.model ?? '');
    setSystemPrompt(tpl.systemPrompt);
    // v0.77: the template's description becomes the bot's description
    // (same pre-fill rule as the system prompt above).
    setDescription(tpl.description ?? '');
  };

  const submit = async () => {
    if (!name.trim()) {
      setError(t('botForm.nameRequired'));
      return;
    }
    setError('');
    setSaving(true);
    try {
      await onSave({
        ...(initial ? { id: initial.id } : {}),
        name: name.trim(),
        description: description.trim() || undefined,
        providerId,
        model: model.trim(),
        disabledProviders,
        systemPrompt,
        workspaceDir: workspaceDir.trim(),
        autoApprove,
        approvalLevel,
        color,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : t('botForm.saveError'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{initial ? t('botForm.editTitle') : t('botForm.createTitle')}</h2>

        {!initial && templates.length > 0 && (
          <div className="field">
            <label htmlFor="bot-template">{t('botForm.templateLabel')}</label>
            <select id="bot-template" value={templateId} onChange={(e) => applyTemplate(e.target.value)}>
              <option value="">{t('botForm.templateNone')}</option>
              {templates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
              ))}
            </select>
            <p className="hint">{t('botForm.templateHint')}</p>
          </div>
        )}

        <div className="field">
          <label htmlFor="bot-name">{t('botForm.nameLabel')}</label>
          <input id="bot-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('botForm.namePlaceholder')} />
        </div>

        <div className="field">
          <label htmlFor="bot-description">{t('botForm.descriptionLabel')}</label>
          <input
            id="bot-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('botForm.descriptionPlaceholder')}
            maxLength={500}
          />
          <p className="hint">{t('botForm.descriptionHint')}</p>
        </div>

        <div className="field">
          <label>{t('botForm.colorLabel')}</label>
          <div className="row wrap" role="radiogroup" aria-label={t('botForm.colorLabel')}>
            {BOT_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`bot-color-swatch${color === c ? ' selected' : ''}`}
                style={{ background: c }}
                data-color={c}
                aria-label={c}
                aria-checked={color === c}
                role="radio"
                onClick={() => setColor(c)}
              />
            ))}
          </div>
          <p className="hint">{t('botForm.colorHint')}</p>
        </div>

        <div className="field">
          <label>{t('botForm.providerLabel')}</label>
          {/* M4: the 3-group provider rail replaces the old provider
          select + free-text model input. The current choice stays
          selected even when its source was disabled since (the row is
          dimmed with the reason, and saving keeps the old values). */}
          <ModelPicker
            value={{ providerId, model }}
            onSelect={(sel) => {
              setProviderId(sel.providerId);
              setModel(sel.model);
            }}
            onToggleEngine={toggleEngine}
            onOpenEngines={onOpenEngines}
            disabledProviders={disabledProviders}
          />
          <p className="hint">{t('botForm.modelHint')}</p>
        </div>

        <div className="field">
          <label>{t('botForm.sourcesLabel')}</label>
          {sourcesRail ? (
            <div>
              {sourcesRail.entries.map((entry) => {
                const disabled = disabledProviders.includes(entry.providerId);
                return (
                  <label key={entry.providerId} className="row" style={{ gap: 8 }}>
                    <input
                      type="checkbox"
                      style={{ width: 'auto' }}
                      data-testid={`bot-source-${entry.providerId}`}
                      checked={!disabled}
                      onChange={(e) =>
                        setDisabledProviders((prev) =>
                          e.target.checked
                            ? prev.filter((id) => id !== entry.providerId)
                            : [...prev, entry.providerId],
                        )
                      }
                    />
                    {entry.label}
                  </label>
                );
              })}
            </div>
          ) : (
            <p className="hint">{t('modelPicker.loading')}</p>
          )}
          <p className="hint">{t('botForm.sourcesHint')}</p>
        </div>

        <div className="field">
          <label htmlFor="bot-prompt">{t('botForm.promptLabel')}</label>
          <textarea
            id="bot-prompt"
            rows={4}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder={t('botForm.promptPlaceholder')}
          />
        </div>

        <div className="field">
          <label htmlFor="bot-workspace">{t('botForm.workspaceLabel')}</label>
          <input
            id="bot-workspace"
            value={workspaceDir}
            onChange={(e) => setWorkspaceDir(e.target.value)}
            placeholder={t('botForm.workspacePlaceholder')}
          />
        </div>

        <div className="field">
          <label className="row" style={{ gap: 8 }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={autoApprove}
              onChange={(e) => setAutoApprove(e.target.checked)}
            />
            {t('botForm.autoApproveLabel')}
          </label>
          <p className="hint">{t('botForm.autoApproveHint')}</p>
        </div>

        <div className="field">
          <label htmlFor="bot-approval-level">{t('botForm.approvalLevelLabel')}</label>
          <select
            id="bot-approval-level"
            value={approvalLevel}
            onChange={(e) =>
              setApprovalLevel(e.target.value as 'ask-always' | 'ask-for-writes' | 'auto-approve-safe')
            }
          >
            <option value="ask-always">{t('botForm.approvalAskAlways')}</option>
            <option value="ask-for-writes">{t('botForm.approvalAskForWrites')}</option>
            <option value="auto-approve-safe">{t('botForm.approvalAutoApproveSafe')}</option>
          </select>
          <p className="hint">{t('botForm.approvalLevelHint')}</p>
        </div>

        {error && <p className="error">{error}</p>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn secondary" onClick={onCancel}>{t('botForm.cancel')}</button>
          <button className="btn" onClick={submit} disabled={saving}>{saving ? t('botForm.saving') : t('botForm.save')}</button>
        </div>
      </div>
    </div>
  );
}
