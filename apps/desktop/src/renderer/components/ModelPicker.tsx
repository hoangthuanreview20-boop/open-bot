import { useEffect, useState } from 'react';
import type { ProviderRailEntryView, ProviderRailView } from '../types';
import { useT } from '../i18n/useT';

/**
 * ModelPicker (M4) — pick a model on the 3-group provider rail:
 * subscription (signed-in CLI), API key, custom. An unusable provider
 * is dimmed with a plain-language reason; an 'unknown' one (custom
 * ACP without a status command) shows "unknown" instead of a made-up
 * state. The picker never renders a secret: the source line is either
 * the account label from the detector snapshot or the words
 * "API key (Vault)" — the key itself is never in the rail payload.
 *
 * Advanced detail stays behind this picker / Settings → Engines
 * (progressive disclosure): the rail shows one row per provider, and
 * the per-engine status (binary, version, opt-in) lives in Engines.
 */

export interface ModelSelection {
  providerId: string;
  model: string;
}

interface Props {
  value: ModelSelection;
  onSelect: (selection: ModelSelection) => void;
  /** Jump to Settings → Engines (optional — without it the rail still works, just without the link). */
  onOpenEngines?: () => void;
  /** Toggle one CLI source on/off from the rail (built-in kinds only). */
  onToggleEngine?: (kind: string, enabled: boolean) => Promise<void>;
  /**
   * v0.90b: providers disabled for this bot — main filters the rail
   * (hidden, except the current provider which stays dimmed with the
   * bot-disabled reason so the picker can warn instead of silently
   * switching the model). Undefined = the global rail (no per-bot
   * filter), as before.
   */
  disabledProviders?: string[];
}

const GROUP_ORDER = ['subscription', 'api', 'custom'] as const;
type RailGroupKey = (typeof GROUP_ORDER)[number];

function groupTitleKey(group: RailGroupKey): string {
  switch (group) {
    case 'subscription':
      return 'modelPicker.groupSubscription';
    case 'api':
      return 'modelPicker.groupApi';
    case 'custom':
      return 'modelPicker.groupCustom';
  }
}

export default function ModelPicker({ value, onSelect, onOpenEngines, onToggleEngine, disabledProviders }: Props) {
  const t = useT();
  const [rail, setRail] = useState<ProviderRailView | null>(null);
  const [error, setError] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [customFor, setCustomFor] = useState('');
  const [toggling, setToggling] = useState('');
  const [redetecting, setRedetecting] = useState(false);
  // Serialised per-bot filter: the rail reloads when the bot's disabled
  // sources (or its current provider) change.
  const disabledKey = JSON.stringify(disabledProviders ?? null);

  const loadRail = async () => {
    try {
      const res = await window.openBot.listModelRail(
        disabledProviders !== undefined
          ? { disabledProviders, currentProviderId: value.providerId }
          : undefined,
      );
      setRail(res);
      setError('');
    } catch {
      setRail(null);
      setError(t('modelPicker.loadError'));
    }
  };

  useEffect(() => {
    void loadRail();
    // Live refresh: a Re-detect / toggle / custom CLI change in
    // Settings pushes a new engines snapshot, and the rail follows
    // without reopening the picker.
    if (typeof window.openBot.onEnginesChanged !== 'function') return undefined;
    return window.openBot.onEnginesChanged(() => void loadRail());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabledKey, value.providerId]);

  /**
   * v0.90b: re-scan the machine for CLIs (same real rescan as
   * Settings → Engines) and reload the rail right away — the picker
   * no longer depends on Settings for a refresh.
   */
  const redetect = async () => {
    if (typeof window.openBot.redetectEngines !== 'function') return;
    setRedetecting(true);
    try {
      await window.openBot.redetectEngines();
      await loadRail();
    } catch {
      setError(t('modelPicker.loadError'));
    } finally {
      setRedetecting(false);
    }
  };

  /** Plain-language reason for a provider that cannot be picked. */
  const reasonText = (entry: ProviderRailEntryView): string => {
    switch (entry.reason) {
      case 'disabled':
        return t('modelPicker.reasonDisabled');
      case 'not-installed':
        return t('modelPicker.reasonNotInstalled');
      case 'not-signed-in':
        return t('modelPicker.reasonNotSignedIn');
      case 'version-too-old':
        return t('modelPicker.reasonVersionTooOld', { minVersion: entry.minVersion ?? '' });
      case 'version-probe-failed':
        return t('modelPicker.reasonProbeFailed');
      case 'auth-check-failed':
        return t('modelPicker.reasonAuthFailed');
      case 'no-api-key':
        return t('modelPicker.reasonNoApiKey');
      case 'not-configured':
        return t('modelPicker.reasonNotConfigured');
      case 'bot-disabled':
        return t('modelPicker.reasonBotDisabled');
      case 'unknown-status':
        return t('modelPicker.reasonUnknown');
      default:
        return entry.reasonDetail ?? '';
    }
  };

  /** Source line: which account (label only) or key the model runs on. Never a secret. */
  const sourceText = (entry: ProviderRailEntryView): string => {
    switch (entry.sourceKind) {
      case 'account':
        if (entry.accountLabel) return t('modelPicker.sourceAccount', { account: entry.accountLabel });
        if (entry.status === 'unknown') return t('modelPicker.sourceUnknown');
        return '';
      case 'api-key':
        return t('modelPicker.sourceApiKey');
      case 'local':
        return t('modelPicker.sourceLocal');
      case 'custom':
        return t('modelPicker.sourceCustom');
    }
  };

  const toggleEngine = async (entry: ProviderRailEntryView) => {
    const kind = entry.detectedKind;
    if (!kind || !onToggleEngine) return;
    setToggling(kind);
    try {
      await onToggleEngine(kind, !(entry.enabled ?? false));
      await loadRail();
    } catch {
      setError(t('modelPicker.loadError'));
    } finally {
      setToggling('');
    }
  };

  const pickModel = (entry: ProviderRailEntryView, model: string) => {
    if (!entry.selectable) return;
    if (model === '__custom__') {
      setCustomFor(entry.providerId);
      return;
    }
    setCustomFor('');
    onSelect({ providerId: entry.providerId, model });
  };

  const confirmCustomModel = (entry: ProviderRailEntryView) => {
    const model = customModel.trim();
    if (!model) return;
    setCustomFor('');
    setCustomModel('');
    onSelect({ providerId: entry.providerId, model });
  };

  if (!rail) {
    return (
      <div>
        {error ? (
          <>
            <p className="error">{error}</p>
            {/* v0.71 (audit): the rail load had a loading line and an
                error but no retry — reopening the picker was the only
                way to reload. */}
            <button className="btn secondary" data-testid="model-picker-retry" onClick={() => void loadRail()}>
              {t('modelPicker.retry')}
            </button>
          </>
        ) : (
          <p className="hint">{t('modelPicker.loading')}</p>
        )}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="btn secondary"
            data-testid="model-picker-redetect"
            disabled={redetecting}
            onClick={() => void redetect()}
          >
            {redetecting ? t('modelPicker.redetecting') : t('modelPicker.redetect')}
          </button>
          {onOpenEngines && (
            <button className="btn secondary" onClick={onOpenEngines}>{t('modelPicker.openEngines')}</button>
          )}
        </div>
      </div>
    );
  }

  const allEmpty = GROUP_ORDER.every((g) => rail.groups[g].length === 0);
  // v0.90b: the running model's source was disabled for this bot —
  // warn clearly and suggest the first usable source instead of
  // silently switching the model (the switch only happens when the
  // user clicks the suggestion).
  const currentEntry = rail.entries.find((e) => e.providerId === value.providerId);
  const currentDisabled = currentEntry?.reason === 'bot-disabled';
  const suggestion = currentDisabled
    ? rail.entries.find((e) => e.selectable && e.providerId !== value.providerId)
    : undefined;

  return (
    <div>
      {currentDisabled && (
        <div data-testid="model-picker-current-disabled">
          <p className="error">{t('modelPicker.currentSourceDisabled')}</p>
          {suggestion && (
            <button
              type="button"
              className="btn secondary"
              data-testid="model-picker-switch-suggestion"
              onClick={() => onSelect({ providerId: suggestion.providerId, model: suggestion.defaultModel })}
            >
              {t('modelPicker.switchToSuggestion', { label: suggestion.label, model: suggestion.defaultModel })}
            </button>
          )}
        </div>
      )}
      {allEmpty && <p className="hint">{t('modelPicker.empty')}</p>}
      {GROUP_ORDER.map((group) => {
        const entries = rail.groups[group];
        if (entries.length === 0) return null;
        return (
          <div key={group} className="rail-group">
            <h4 style={{ margin: '14px 0 6px', fontSize: 12, textTransform: 'uppercase', color: 'var(--text-dim)', letterSpacing: '.04em' }}>
              {t(groupTitleKey(group))}
            </h4>
            {entries.map((entry) => {
              const selected = value.providerId === entry.providerId;
              const currentModel = selected ? value.model : entry.defaultModel;
              const modelInList = entry.models.includes(currentModel);
              return (
                <div
                  key={entry.providerId}
                  className={`rail-row${selected ? ' selected' : ''}${entry.selectable ? '' : ' dimmed'}`}
                >
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <button
                      type="button"
                      className="rail-pick"
                      disabled={!entry.selectable}
                      onClick={() => pickModel(entry, modelInList ? currentModel : entry.defaultModel)}
                      title={entry.selectable ? entry.label : reasonText(entry)}
                    >
                      <strong>{entry.label}</strong>
                      {sourceText(entry) && <span className="hint"> · {sourceText(entry)}</span>}
                    </button>
                    {entry.detectedKind && !entry.detectedKind.startsWith('custom-acp') && onToggleEngine && (
                      <button
                        type="button"
                        className="btn secondary"
                        disabled={toggling === entry.detectedKind}
                        onClick={() => void toggleEngine(entry)}
                      >
                        {entry.enabled ? t('modelPicker.disable') : t('modelPicker.enable')}
                      </button>
                    )}
                  </div>
                  {!entry.selectable && (
                    <p className="hint" style={{ margin: '4px 0 0' }}>{reasonText(entry)}</p>
                  )}
                  {entry.selectable && entry.status === 'unknown' && (
                    <p className="hint" style={{ margin: '4px 0 0' }}>{reasonText(entry)}</p>
                  )}
                  {entry.selectable && (
                    <div className="row" style={{ marginTop: 8 }}>
                      <select
                        aria-label={entry.label}
                        value={modelInList ? currentModel : '__custom__'}
                        onChange={(e) => pickModel(entry, e.target.value)}
                      >
                        {entry.models.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                        <option value="__custom__">{t('modelPicker.customModel')}</option>
                      </select>
                    </div>
                  )}
                  {entry.selectable && customFor === entry.providerId && (
                    <div className="row" style={{ marginTop: 8 }}>
                      <input
                        value={customModel}
                        onChange={(e) => setCustomModel(e.target.value)}
                        placeholder={t('modelPicker.customModelPlaceholder')}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') confirmCustomModel(entry);
                        }}
                      />
                      <button
                        type="button"
                        className="btn secondary"
                        disabled={!customModel.trim()}
                        onClick={() => confirmCustomModel(entry)}
                      >
                        OK
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
      {error && <p className="error">{error}</p>}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button
          type="button"
          className="btn secondary"
          data-testid="model-picker-redetect"
          disabled={redetecting}
          onClick={() => void redetect()}
        >
          {redetecting ? t('modelPicker.redetecting') : t('modelPicker.redetect')}
        </button>
        {onOpenEngines && (
          <button className="btn secondary" onClick={onOpenEngines}>{t('modelPicker.openEngines')}</button>
        )}
      </div>
    </div>
  );
}
