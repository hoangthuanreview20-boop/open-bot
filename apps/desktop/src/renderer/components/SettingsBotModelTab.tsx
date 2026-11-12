/**
 * Bot & Model settings tab (UI-4, v0.59) — small-model guard,
 * auto-approve rules, model registry (+ Ollama), engines / custom CLIs,
 * provider API keys, and the Save button for provider settings.
 *
 * Pure render over `SettingsShared` (see `settings/settingsShared.ts`):
 * all state, IPC and handlers still live in `SettingsView`. The JSX
 * below moved verbatim from `SettingsView`; only a `data-section`
 * marker and the `onlySections` search filter were added.
 */
import EngineStatusView from './EngineStatusView';
import { MODEL_FEATURES, PROVIDER_META } from './SettingsView';
import type { SettingsSectionId } from './settings/settingsTabs';
import type { SettingsShared } from './settings/settingsShared';

interface Props {
  s: SettingsShared;
  /** When set (search mode), render only these sections. */
  onlySections?: SettingsSectionId[];
}

export default function SettingsBotModelTab({ s, onlySections }: Props) {
  const {
    t, data, selectedBot, changeSmallModelGuard,
    autoApproveRules, autoApproveError, autoApproveLoading, reloadAutoApprove,
    toggleAutoApproveRule, removeAutoApproveRule,
    addAutoApproveRule, aaKind, setAaKind, aaPattern, setAaPattern, aaTool, setAaTool,
    aaArgsPattern, setAaArgsPattern, aaScope, setAaScope, aaBotId, setAaBotId, aaNote, setAaNote,
    registry, registryError, registryLoading, reloadRegistry,
    featureValue, setModelChoice, changeFeatureModel, changeFeatureFlag,
    ollamaModels, ollamaInput, setOllamaInput, pulling, pullOllama, ollamaMessage,
    ollamaLoading, ollamaError, reloadOllama,
    engines, enginesError, enginesLoading, reloadEngines, redetecting, redetectEngines, redetectingKind,
    toggleEngine, redetectOneEngine, editCustomCli, removeCustomCli,
    customEditingId, setCustomEditingId, customId, setCustomId, customLabel, setCustomLabel,
    customBinaryPath, setCustomBinaryPath, customAcpArgs, setCustomAcpArgs,
    customStatusArgs, setCustomStatusArgs, customSaving, saveCustomCli,
    draft, setField, test, testing, testResult, save,
  } = s;
  const show = (id: SettingsSectionId) => !onlySections || onlySections.includes(id);
  return (
    <>
      {show('smallModelGuard') && selectedBot && (
        <section data-section="smallModelGuard" className="card">
          <h3>{t('settings.smallModelGuardTitle', { name: selectedBot.name })}</h3>
          <p className="hint">{t('settings.smallModelGuardHint')}</p>
          <label>
            <input
              type="checkbox"
              checked={selectedBot.smallModelGuard ?? true}
              onChange={(e) => void changeSmallModelGuard(e.target.checked)}
            />
            {t('settings.smallModelGuardLabel')}
          </label>
        </section>
      )}

      {show('autoApprove') && (
        <section data-section="autoApprove" className="card">
          <h3>{t('settings.autoApproveTitle')}</h3>
          <p className="hint">{t('settings.autoApproveHint')}</p>
          {/* v0.68c: the empty line used to show while the rules were
              still loading — loading and error + retry are explicit
              now, and the empty line waits for a finished load. */}
          {autoApproveLoading && (
            <p className="hint" data-testid="auto-approve-loading">{t('settings.autoApproveLoading')}</p>
          )}
          {autoApproveError && (
            <>
              <p className="error">{autoApproveError}</p>
              <button className="btn secondary" data-testid="auto-approve-retry" onClick={() => void reloadAutoApprove()}>
                {t('settings.retry')}
              </button>
            </>
          )}
          {!autoApproveLoading && !autoApproveError && autoApproveRules.length === 0 && (
            <p className="hint">{t('settings.autoApproveEmpty')}</p>
          )}
          {autoApproveRules.length > 0 && (
            <ul>
              {autoApproveRules.map((rule) => (
                <li key={rule.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={(e) => void toggleAutoApproveRule(rule.id, e.target.checked)}
                    />
                    {t('settings.autoApproveEnabled')}
                  </label>
                  {' '}
                  <code>
                    {rule.kind === 'shell'
                      ? rule.pattern
                      : `${rule.tool ?? ''}${rule.argsPattern ? ` ${JSON.stringify(rule.argsPattern)}` : ''}`}
                  </code>
                  {' — '}
                  {rule.scope === 'global'
                    ? t('settings.autoApproveScopeGlobal')
                    : (data?.bots.find((b) => b.id === rule.botId)?.name ?? rule.botId ?? '')}
                  {rule.note ? ` — ${rule.note}` : ''}
                  {' '}
                  <button className="btn secondary" onClick={() => void removeAutoApproveRule(rule.id)}>
                    {t('settings.autoApproveDelete')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div>
            <label>
              {t('settings.autoApproveKindLabel')}{' '}
              <select value={aaKind} onChange={(e) => setAaKind(e.target.value as 'shell' | 'tool')}>
                <option value="shell">{t('settings.autoApproveKindShell')}</option>
                <option value="tool">{t('settings.autoApproveKindTool')}</option>
              </select>
            </label>
            {' '}
            {aaKind === 'shell' ? (
              <label>
                {t('settings.autoApprovePatternLabel')}{' '}
                <input
                  type="text"
                  value={aaPattern}
                  onChange={(e) => setAaPattern(e.target.value)}
                  placeholder={t('settings.autoApprovePatternPlaceholder')}
                />
              </label>
            ) : (
              <>
                <label>
                  {t('settings.autoApproveToolLabel')}{' '}
                  <input
                    type="text"
                    value={aaTool}
                    onChange={(e) => setAaTool(e.target.value)}
                    placeholder={t('settings.autoApproveToolPlaceholder')}
                  />
                </label>
                {' '}
                <label>
                  {t('settings.autoApproveArgsLabel')}{' '}
                  <input
                    type="text"
                    value={aaArgsPattern}
                    onChange={(e) => setAaArgsPattern(e.target.value)}
                    placeholder={t('settings.autoApproveArgsPlaceholder')}
                  />
                </label>
              </>
            )}
            {' '}
            <label>
              {t('settings.autoApproveScopeLabel')}{' '}
              <select value={aaScope} onChange={(e) => setAaScope(e.target.value as 'global' | 'bot')}>
                <option value="global">{t('settings.autoApproveScopeGlobal')}</option>
                <option value="bot">{t('settings.autoApproveScopeBot')}</option>
              </select>
            </label>
            {aaScope === 'bot' && (
              <>
                {' '}
                <select value={aaBotId} onChange={(e) => setAaBotId(e.target.value)}>
                  <option value="">{t('settings.autoApproveScopeBot')}</option>
                  {(data?.bots ?? []).map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </>
            )}
            {' '}
            <label>
              {t('settings.autoApproveNoteLabel')}{' '}
              <input
                type="text"
                value={aaNote}
                onChange={(e) => setAaNote(e.target.value)}
                placeholder={t('settings.autoApproveNotePlaceholder')}
              />
            </label>
            {' '}
            <button className="btn" onClick={() => void addAutoApproveRule()}>
              {t('settings.autoApproveAdd')}
            </button>
          </div>
        </section>
      )}

      {show('models') && (
        <section data-section="models" className="card">
          <h3>{t('settings.modelsTitle')}</h3>
          <p className="hint">{t('settings.modelsIntro')}</p>
          {/* v0.68c: before the first registry load finished, the
              feature selects rendered empty with no explanation — the
              section now shows a loading line, and a failed load gets
              a retry next to the error. */}
          {registryLoading && (
            <p className="hint" data-testid="models-loading">{t('settings.modelsLoading')}</p>
          )}
          {registryError && (
            <>
              <p className="error">{registryError}</p>
              <button className="btn secondary" data-testid="models-retry" onClick={() => void reloadRegistry()}>
                {t('settings.retry')}
              </button>
            </>
          )}
          {registry && Object.keys(registry.providers).length === 0 && <p>{t('settings.modelsEmpty')}</p>}
          {registry &&
            Object.entries(registry.providers).map(([pid, entry]) => (
              <div key={pid} className="card">
                <h3>{pid}</h3>
                <div className="field">
                  <label htmlFor={`model-default-${pid}`}>{t('settings.modelsDefaultLabel')}</label>
                  <select
                    id={`model-default-${pid}`}
                    value={entry.defaultModel}
                    onChange={(e) => void setModelChoice('default', pid, e.target.value)}
                  >
                    {entry.models.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                    {entry.defaultModel && !entry.models.some((m) => m.id === entry.defaultModel) && (
                      <option value={entry.defaultModel}>{entry.defaultModel}</option>
                    )}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={`model-fallback-${pid}`}>{t('settings.modelsFallbackLabel')}</label>
                  <select
                    id={`model-fallback-${pid}`}
                    value={entry.fallbackModel}
                    onChange={(e) => void setModelChoice('fallback', pid, e.target.value)}
                  >
                    {entry.models.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                    {entry.fallbackModel && !entry.models.some((m) => m.id === entry.fallbackModel) && (
                      <option value={entry.fallbackModel}>{entry.fallbackModel}</option>
                    )}
                  </select>
                </div>
              </div>
            ))}

          <h3>{t('settings.modelsFeatureTitle')}</h3>
          <p className="hint">{t('settings.modelsFeatureIntro')}</p>
          {MODEL_FEATURES.map((feature) => (
            <div key={feature.id} className="field">
              <label htmlFor={`model-feature-${feature.id}`}>{t(feature.labelKey)}</label>
              <select
                id={`model-feature-${feature.id}`}
                value={registry ? featureValue(feature.id) : ''}
                onChange={(e) => void changeFeatureModel(feature.id, e.target.value)}
              >
                <option value="">{t('settings.modelsFeatureNone')}</option>
                {registry &&
                  Object.entries(registry.providers).flatMap(([pid, entry]) =>
                    entry.models.map((m) => (
                      <option key={`${pid}:${m.id}`} value={`${pid}:${m.id}`}>
                        {pid} / {m.label}
                      </option>
                    )),
                  )}
              </select>
            </div>
          ))}

          <h3>{t('settings.modelsFlagsTitle')}</h3>
          {registry &&
            Object.entries(registry.featureFlags).map(([name, enabled]) => {
              const label = t(`settings.modelsFlag.${name}`);
              return (
                <label key={name} style={{ display: 'block' }}>
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => void changeFeatureFlag(name, e.target.checked)}
                  />
                  {label === `settings.modelsFlag.${name}` ? name : label}
                </label>
              );
            })}

          <h3>{t('settings.modelsOllamaTitle')}</h3>
          <p className="hint">{t('settings.modelsOllamaIntro')}</p>
          {/* v0.68c: a failed Ollama list used to look exactly like
              "no Ollama models on this machine" — loading and error +
              retry are explicit now. */}
          {ollamaLoading && (
            <p className="hint" data-testid="ollama-loading">{t('settings.modelsOllamaLoading')}</p>
          )}
          {ollamaError && (
            <>
              <p className="error">{ollamaError}</p>
              <button className="btn secondary" data-testid="ollama-retry" onClick={() => void reloadOllama()}>
                {t('settings.retry')}
              </button>
            </>
          )}
          {!ollamaLoading && !ollamaError && ollamaModels.length === 0 && <p>{t('settings.modelsOllamaEmpty')}</p>}
          <ul>
            {ollamaModels.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
          <div className="field">
            <label htmlFor="ollama-pull">{t('settings.modelsOllamaPullLabel')}</label>
            <input
              id="ollama-pull"
              value={ollamaInput}
              onChange={(e) => setOllamaInput(e.target.value)}
              placeholder={t('settings.modelsOllamaPullPlaceholder')}
            />
          </div>
          <button className="btn secondary" onClick={() => void pullOllama()} disabled={pulling || !ollamaInput.trim()}>
            {pulling ? t('settings.modelsOllamaPulling') : t('settings.modelsOllamaPull')}
          </button>
          {ollamaMessage && <p style={{ margin: '8px 0 0' }}>{ollamaMessage}</p>}
        </section>
      )}

      {show('engines') && (
        <section data-section="engines" className="card">
          <h3>{t('settings.enginesTitle')}</h3>
          <p className="hint">{t('settings.enginesIntro')}</p>
          {/* v0.69c: a failed load used to show the error next to the
              generic loading line (engines stayed null, so the "still
              loading" line never went away) with no retry — loading
              and error + retry are explicit now, and the empty line
              waits for a finished load. */}
          {enginesLoading && (
            <p className="hint" data-testid="engines-loading">{t('settings.enginesLoading')}</p>
          )}
          {enginesError && (
            <>
              <p className="error">{enginesError}</p>
              <button className="btn secondary" data-testid="engines-retry" onClick={() => void reloadEngines()}>
                {t('settings.retry')}
              </button>
            </>
          )}
          <button className="btn secondary" onClick={() => void redetectEngines()} disabled={redetecting}>
            {redetecting ? t('settings.enginesRedetecting') : t('settings.enginesRedetect')}
          </button>
          {!enginesLoading && !enginesError && engines && Object.keys(engines.engines).length === 0 && (
            <p className="hint">{t('settings.enginesEmpty')}</p>
          )}
          {engines && Object.keys(engines.engines).length > 0 && (
            <EngineStatusView
              engines={engines}
              redetectingKind={redetectingKind}
              onToggle={(kind, enabled) => void toggleEngine(kind, enabled)}
              onRedetectOne={(kind) => void redetectOneEngine(kind)}
              onEditCustom={(engine) => void editCustomCli(engine)}
              onRemoveCustom={(engine) => void removeCustomCli(engine)}
            />
          )}
          {/* M3: "Set CLI…" — point open-bot at any ACP-speaking CLI. */}
          <h4>{t('settings.customCliTitle')}</h4>
          <p className="hint">{t('settings.customCliIntro')}</p>
          <div className="field">
            <label htmlFor="custom-cli-id">{t('settings.customCliIdLabel')}</label>
            <input
              id="custom-cli-id"
              value={customId}
              disabled={customEditingId !== null}
              onChange={(e) => setCustomId(e.target.value)}
              placeholder={t('settings.customCliIdPlaceholder')}
            />
          </div>
          <div className="field">
            <label htmlFor="custom-cli-label">{t('settings.customCliLabelLabel')}</label>
            <input
              id="custom-cli-label"
              value={customLabel}
              onChange={(e) => setCustomLabel(e.target.value)}
              placeholder={t('settings.customCliLabelPlaceholder')}
            />
          </div>
          <div className="field">
            <label htmlFor="custom-cli-binary">{t('settings.customCliBinaryLabel')}</label>
            <input
              id="custom-cli-binary"
              value={customBinaryPath}
              onChange={(e) => setCustomBinaryPath(e.target.value)}
              placeholder={t('settings.customCliBinaryPlaceholder')}
            />
          </div>
          <div className="field">
            <label htmlFor="custom-cli-args">{t('settings.customCliArgsLabel')}</label>
            <input
              id="custom-cli-args"
              value={customAcpArgs}
              onChange={(e) => setCustomAcpArgs(e.target.value)}
              placeholder={t('settings.customCliArgsPlaceholder')}
            />
            <p className="hint">{t('settings.customCliArgsHint')}</p>
          </div>
          <div className="field">
            <label htmlFor="custom-cli-status-args">{t('settings.customCliStatusArgsLabel')}</label>
            <input
              id="custom-cli-status-args"
              value={customStatusArgs}
              onChange={(e) => setCustomStatusArgs(e.target.value)}
              placeholder={t('settings.customCliStatusArgsPlaceholder')}
            />
          </div>
          <div className="row">
            <button className="btn secondary" onClick={() => void saveCustomCli()} disabled={customSaving}>
              {customEditingId !== null ? t('settings.customCliSave') : t('settings.customCliAdd')}
            </button>
            {customEditingId !== null && (
              <button
                className="btn secondary"
                onClick={() => {
                  setCustomEditingId(null);
                  setCustomId('');
                  setCustomLabel('');
                  setCustomBinaryPath('');
                  setCustomAcpArgs('acp');
                  setCustomStatusArgs('');
                }}
              >
                {t('settings.customCliCancel')}
              </button>
            )}
          </div>
        </section>
      )}

      {show('providers') &&
        PROVIDER_META.filter((meta) => !meta.cliKind).map((meta) => {
          const p = data?.providers[meta.id];
          const v = draft[meta.id] ?? { apiKey: '', baseUrl: '', defaultModel: '' };
          return (
            <section key={meta.id} data-section={`provider-${meta.id}`} className="card">
              <h3>{t(meta.labelKey)} {p?.apiKeySet && <span className="badge done">{t('settings.keySavedBadge')}</span>}</h3>
              {meta.needsKey && (
                <div className="field">
                  <label htmlFor={`key-${meta.id}`}>{t('settings.apiKeyLabel')}</label>
                  <input
                    id={`key-${meta.id}`}
                    type="password"
                    autoComplete="off"
                    value={v.apiKey}
                    onChange={(e) => setField(meta.id, 'apiKey', e.target.value)}
                    placeholder={p?.apiKeySet ? t('settings.keyPlaceholderSaved') : t('settings.keyPlaceholderEmpty')}
                  />
                </div>
              )}
              <div className="field">
                <label htmlFor={`url-${meta.id}`}>{t('settings.baseUrlLabel')}</label>
                <input
                  id={`url-${meta.id}`}
                  value={v.baseUrl}
                  onChange={(e) => setField(meta.id, 'baseUrl', e.target.value)}
                  placeholder={meta.placeholderBaseUrl}
                />
              </div>
              <div className="field">
                <label htmlFor={`model-${meta.id}`}>{t('settings.defaultModelLabel')}</label>
                <input
                  id={`model-${meta.id}`}
                  value={v.defaultModel}
                  onChange={(e) => setField(meta.id, 'defaultModel', e.target.value)}
                  placeholder={t('settings.modelPlaceholder')}
                />
              </div>
              <button className="btn secondary" onClick={() => test(meta.id)} disabled={testing === meta.id}>
                {testing === meta.id ? t('settings.testing') : t('settings.testButton')}
              </button>
              {testResult[meta.id] && <p style={{ margin: '8px 0 0' }}>{testResult[meta.id]}</p>}
            </section>
          );
        })}

      {show('providers') && (
        <div className="row">
          <button className="btn" onClick={save}>{t('settings.saveButton')}</button>
        </div>
      )}
    </>
  );
}
