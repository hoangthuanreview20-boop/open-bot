/**
 * RouterPanel — view + tune the per-turn model router (v0.96, Team T3;
 * IPC wiring + persistent history + CLI/API targets in v0.98, Team T2).
 *
 * Reads real data over IPC `router:decisions` / `router:stats` /
 * `router:get-config` / `router:targets` (main → coordinator RPC) and
 * pushes config changes down over `router:set-config`. New decisions
 * also arrive live via `router:changed` (pushed by main on every
 * `router.decision` harness event) so the history refreshes without
 * polling. When IPC is unavailable (old preload / test render) the
 * panel falls back to the localStorage config cache and shows an
 * explicit error + retry instead of inventing numbers.
 *
 * Props `decisions` / `stats` (v0.96) still work as an initial
 * override — e.g. renderer smoke tests that pass props — but with no
 * props the panel fetches everything itself.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from '../i18n/useT';
import type {
  RouterCliStatusView,
  RouterConfigView,
  RouterDecisionView,
  RouterStatsView,
  RouterTargetsView,
} from '../types';

/** Panel default config (matches DEFAULT_ROUTER_CONFIG in core). */
export const DEFAULT_ROUTER_PANEL_SETTINGS: RouterConfigView = {
  enabled: true,
  layers: { structural: true, semantic: true, decision: true },
  simpleMax: 0.15,
  complexMin: 0.3,
  minSemanticConfidence: 0.35,
  minSemanticMargin: 0.08,
  minDecisionConfidence: 0.5,
  decisionTimeoutMs: 4000,
  pinTtlTurns: 0,
  pinBreakContextRatio: 0.9,
  maxLogEntries: 100,
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  decisionModel: 'qwen2.5:0.5b',
  allowLocal: true,
  allowCli: true,
  allowApi: true,
  disabledProviders: [],
};

/** Slim shape kept compatible with the old v0.96 localStorage settings. */
export interface RouterPanelSettings {
  enabled: boolean;
  simpleMax: number;
  complexMin: number;
  layers: { structural: boolean; semantic: boolean; decision: boolean };
}

const STORAGE_KEY = 'open-bot:router-panel:v1';

function loadStoredConfig(): RouterConfigView {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_ROUTER_PANEL_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<RouterConfigView>;
    return {
      ...DEFAULT_ROUTER_PANEL_SETTINGS,
      ...parsed,
      layers: { ...DEFAULT_ROUTER_PANEL_SETTINGS.layers, ...(parsed.layers ?? {}) },
      disabledProviders: Array.isArray(parsed.disabledProviders) ? parsed.disabledProviders : [],
    };
  } catch {
    return DEFAULT_ROUTER_PANEL_SETTINGS;
  }
}

function storeConfig(config: RouterConfigView): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // localStorage full / blocked: config lives only for this session.
  }
}

type OpenBotRouterApi = {
  getRouterDecisions?: (payload?: { botId?: string; limit?: number }) => Promise<{ decisions: RouterDecisionView[]; total: number }>;
  getRouterStats?: (payload?: { botId?: string }) => Promise<RouterStatsView>;
  getRouterConfig?: () => Promise<RouterConfigView>;
  setRouterConfig?: (config: Partial<RouterConfigView>) => Promise<RouterConfigView>;
  clearRouterLog?: (payload?: { botId?: string }) => Promise<{ cleared: number }>;
  getRouterTargets?: () => Promise<RouterTargetsView>;
  onRouterChanged?: (cb: (payload: { botId: string; at: number }) => void) => () => void;
};

function routerApi(): OpenBotRouterApi | null {
  try {
    const api = (window as unknown as { openBot?: OpenBotRouterApi }).openBot;
    return api ?? null;
  } catch {
    return null;
  }
}

interface Props {
  t: TFunction;
  /** Most recent decisions first (newest first) — override for tests. */
  decisions?: RouterDecisionView[];
  stats?: RouterStatsView | null;
  /** Bots for the per-bot history filter (Settings passes data.bots). */
  bots?: Array<{ id: string; name: string }>;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export default function RouterPanel({ t, decisions: decisionsProp, stats: statsProp, bots = [] }: Props) {
  const [config, setConfig] = useState<RouterConfigView>(loadStoredConfig);
  const [decisions, setDecisions] = useState<RouterDecisionView[]>(decisionsProp ?? []);
  const [stats, setStats] = useState<RouterStatsView | null>(statsProp ?? null);
  const [targets, setTargets] = useState<RouterTargetsView | null>(null);
  const [botFilter, setBotFilter] = useState<string>('all');
  const [loading, setLoading] = useState(decisionsProp === undefined);
  const [error, setError] = useState('');
  const [ipcAvailable, setIpcAvailable] = useState(true);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const configDirty = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  const loadAll = useCallback(async () => {
    const api = routerApi();
    if (!api?.getRouterDecisions || !api?.getRouterStats || !api?.getRouterConfig) {
      setIpcAvailable(false);
      setLoading(false);
      return;
    }
    setIpcAvailable(true);
    setLoading(true);
    setError('');
    try {
      const botId = botFilter === 'all' ? undefined : botFilter;
      const [configRes, decisionsRes, statsRes, targetsRes] = await Promise.all([
        api.getRouterConfig(),
        api.getRouterDecisions({ ...(botId !== undefined ? { botId } : {}), limit: 20 }),
        api.getRouterStats({ ...(botId !== undefined ? { botId } : {}) }),
        api.getRouterTargets ? api.getRouterTargets().catch(() => null) : Promise.resolve(null),
      ]);
      if (!mounted.current) return;
      configDirty.current = false;
      const merged = {
        ...DEFAULT_ROUTER_PANEL_SETTINGS,
        ...configRes,
        layers: { ...DEFAULT_ROUTER_PANEL_SETTINGS.layers, ...(configRes.layers ?? {}) },
      };
      setConfig(merged);
      storeConfig(merged);
      setDecisions(decisionsProp ?? decisionsRes.decisions);
      setStats(statsProp ?? statsRes);
      setTargets(targetsRes);
      setError('');
    } catch {
      if (!mounted.current) return;
      setError(t('router.loadError'));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [botFilter, decisionsProp, statsProp, t]);

  useEffect(() => {
    mounted.current = true;
    void loadAll();
    return () => {
      mounted.current = false;
    };
  }, [loadAll]);

  // New decision from the coordinator -> reload history + stats.
  useEffect(() => {
    const api = routerApi();
    if (!api?.onRouterChanged) return undefined;
    return api.onRouterChanged(() => {
      void loadAll();
    });
  }, [loadAll]);

  // Save config down to the coordinator (debounce 400ms after last change).
  // Only save when the user really changed it (configDirty) — never save
  // back the config just pulled from IPC, to avoid a load -> save -> load loop.
  useEffect(() => {
    if (!configDirty.current) return undefined;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveStatus('saving');
    saveTimer.current = setTimeout(() => {
      const api = routerApi();
      storeConfig(config);
      if (!api?.setRouterConfig) {
        setSaveStatus('idle');
        return;
      }
      void api
        .setRouterConfig(config)
        .then((effective) => {
          if (!mounted.current) return;
          configDirty.current = false;
          setConfig((prev) => ({ ...prev, ...effective }));
          setSaveStatus('saved');
        })
        .catch(() => {
          if (!mounted.current) return;
          setSaveStatus('error');
        });
    }, 400);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [config]);

  const patchConfig = (patch: Partial<RouterConfigView>) => {
    configDirty.current = true;
    setConfig((prev) => ({ ...prev, ...patch }));
  };

  const setLayer = (layer: keyof RouterConfigView['layers'], on: boolean) => {
    configDirty.current = true;
    setConfig((prev) => ({ ...prev, layers: { ...prev.layers, [layer]: on } }));
  };

  const setAllow = (kind: 'allowLocal' | 'allowCli' | 'allowApi', on: boolean) => {
    configDirty.current = true;
    setConfig((prev) => ({ ...prev, [kind]: on }));
  };

  const toggleDisabledProvider = (providerId: string, disabled: boolean) => {
    configDirty.current = true;
    setConfig((prev) => {
      const set = new Set(prev.disabledProviders);
      if (disabled) set.add(providerId);
      else set.delete(providerId);
      return { ...prev, disabledProviders: [...set].sort() };
    });
  };

  const clearLog = () => {
    const api = routerApi();
    if (!api?.clearRouterLog) return;
    const botId = botFilter === 'all' ? undefined : botFilter;
    void api
      .clearRouterLog({ ...(botId !== undefined ? { botId } : {}) })
      .then(() => void loadAll())
      .catch(() => setError(t('router.loadError')));
  };

  const latest = decisions[0];
  const botName = (id: string): string => bots.find((b) => b.id === id)?.name ?? id;
  const providerOptions = collectProviderOptions(targets);

  return (
    <section data-section="router" className="card" data-testid="router-panel">
      <h3>{t('router.title')}</h3>
      <p className="hint">{t('router.hint')}</p>

      {!ipcAvailable && <p className="hint" data-testid="router-local-fallback">{t('router.localFallback')}</p>}
      {loading && <p className="hint" data-testid="router-loading">{t('router.loading')}</p>}
      {error && (
        <>
          <p className="error" data-testid="router-error">{error}</p>
          <button className="btn secondary" data-testid="router-retry" onClick={() => void loadAll()}>
            {t('router.retry')}
          </button>
        </>
      )}

      <h4>{t('router.configTitle')}</h4>
      <label>
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(e) => patchConfig({ enabled: e.target.checked })}
        />
        {t('router.enabledLabel')}
      </label>

      <div className="router-thresholds">
        <label>
          {t('router.simpleMaxLabel')}
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={config.simpleMax}
            disabled={!config.enabled}
            onChange={(e) =>
              patchConfig({ simpleMax: Math.min(1, Math.max(0, Number(e.target.value) || 0)) })
            }
          />
        </label>
        <label>
          {t('router.complexMinLabel')}
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={config.complexMin}
            disabled={!config.enabled}
            onChange={(e) =>
              patchConfig({ complexMin: Math.min(1, Math.max(0, Number(e.target.value) || 0)) })
            }
          />
        </label>
      </div>

      <fieldset className="router-layers">
        <legend>{t('router.layersTitle')}</legend>
        {(['structural', 'semantic', 'decision'] as const).map((layer) => (
          <label key={layer}>
            <input
              type="checkbox"
              checked={config.layers[layer]}
              disabled={!config.enabled}
              onChange={(e) => setLayer(layer, e.target.checked)}
            />
            {t(`router.layer.${layer}`)}
          </label>
        ))}
      </fieldset>

      <fieldset className="router-allow">
        <legend>{t('router.allowTitle')}</legend>
        <label>
          <input
            type="checkbox"
            checked={config.allowLocal}
            disabled={!config.enabled}
            onChange={(e) => setAllow('allowLocal', e.target.checked)}
          />
          {t('router.allowLocal')}
        </label>
        <label>
          <input
            type="checkbox"
            checked={config.allowCli}
            disabled={!config.enabled}
            onChange={(e) => setAllow('allowCli', e.target.checked)}
          />
          {t('router.allowCli')}
        </label>
        <label>
          <input
            type="checkbox"
            checked={config.allowApi}
            disabled={!config.enabled}
            onChange={(e) => setAllow('allowApi', e.target.checked)}
          />
          {t('router.allowApi')}
        </label>
      </fieldset>

      {providerOptions.length > 0 && (
        <fieldset className="router-disabled">
          <legend>{t('router.disabledTitle')}</legend>
          <p className="hint">{t('router.disabledHint')}</p>
          {providerOptions.map((p) => (
            <label key={p.id}>
              <input
                type="checkbox"
                checked={config.disabledProviders.includes(p.id)}
                disabled={!config.enabled}
                onChange={(e) => toggleDisabledProvider(p.id, e.target.checked)}
                data-testid={`router-disable-provider-${p.id}`}
              />
              {p.label}
            </label>
          ))}
        </fieldset>
      )}

      <details className="router-advanced">
        <summary>{t('router.advancedTitle')}</summary>
        <div className="router-thresholds">
          <label>
            {t('router.minSemanticConfidenceLabel')}
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={config.minSemanticConfidence}
              disabled={!config.enabled}
              onChange={(e) =>
                patchConfig({ minSemanticConfidence: Math.min(1, Math.max(0, Number(e.target.value) || 0)) })
              }
            />
          </label>
          <label>
            {t('router.minDecisionConfidenceLabel')}
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={config.minDecisionConfidence}
              disabled={!config.enabled}
              onChange={(e) =>
                patchConfig({ minDecisionConfidence: Math.min(1, Math.max(0, Number(e.target.value) || 0)) })
              }
            />
          </label>
          <label>
            {t('router.decisionTimeoutLabel')}
            <input
              type="number"
              min={500}
              max={60000}
              step={500}
              value={config.decisionTimeoutMs}
              disabled={!config.enabled}
              onChange={(e) =>
                patchConfig({ decisionTimeoutMs: Math.min(60000, Math.max(500, Number(e.target.value) || 4000)) })
              }
            />
          </label>
        </div>
      </details>

      <p className="hint" data-testid="router-save-status">
        {saveStatus === 'saving'
          ? t('router.saving')
          : saveStatus === 'saved'
            ? t('router.saved')
            : saveStatus === 'error'
              ? t('router.saveError')
              : ''}
      </p>

      {stats && (
        <div className="router-stats" data-testid="router-stats">
          <h4>{t('router.statsTitle')}</h4>
          <p>
            {t('router.statsLine', {
              local: stats.localTurns,
              cloud: stats.cloudTurns,
              saved: stats.estimatedSavingsUsd.toFixed(4),
              latency: Math.round(stats.avgLatencyMs),
            })}
          </p>
          <ul>
            <li>{t('router.statsTotal', { count: stats.totalDecisions })}</li>
            <li>{t('router.statsCli', { count: stats.cliTurns })}</li>
            <li>{t('router.statsApi', { count: stats.apiTurns })}</li>
            <li>{t('router.statsFallback', { pct: Math.round(stats.fallbackRate * 100) })}</li>
            <li>
              {t('router.statsLatency', {
                p50: Math.round(stats.latencyP50Ms),
                p95: Math.round(stats.latencyP95Ms),
              })}
            </li>
          </ul>
        </div>
      )}

      {targets && (
        <div className="router-targets" data-testid="router-targets">
          <h4>{t('router.targetsTitle')}</h4>
          {targets.targets.length === 0 ? (
            <p className="hint">{t('router.targetsEmpty')}</p>
          ) : (
            <ul>
              {targets.local && (
                <li>
                  {t('router.targetLocal')}: {targets.local.providerId}/{targets.local.model}
                </li>
              )}
              {targets.cli.map((target) => (
                <li key={target.id}>
                  {t('router.targetCli')}: {target.providerId}/{target.model}
                </li>
              ))}
              {targets.api.map((target) => (
                <li key={target.id}>
                  {t('router.targetApi')}: {target.providerId}/{target.model}
                </li>
              ))}
            </ul>
          )}
          {targets.cliStatus.length > 0 && (
            <ul className="router-cli-status">
              {targets.cliStatus.map((s: RouterCliStatusView) => (
                <li key={s.providerId}>
                  {s.label} — {s.offered ? t('router.targetOffered') : t('router.targetNotOffered')}
                  {!s.offered && s.reason ? ` (${s.reason})` : ''}
                  {!s.enabled ? ` (${t('router.targetDisabled')})` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="router-history" data-testid="router-history">
        <h4>{t('router.historyTitle')}</h4>
        {bots.length > 1 && (
          <label>
            {t('router.botFilterLabel')}
            <select
              value={botFilter}
              onChange={(e) => setBotFilter(e.target.value)}
              data-testid="router-bot-filter"
            >
              <option value="all">{t('router.botFilterAll')}</option>
              {bots.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {latest ? (
          <div className="router-latest">
            <p>
              <strong>
                {latest.target.providerId}/{latest.target.model}
              </strong>{' '}
              <span className="badge">{latest.layer}</span>{' '}
              {latest.pinned && <span className="badge">{t('router.pinnedBadge')}</span>}{' '}
              {botFilter === 'all' && <span className="hint">{botName(latest.botId)}</span>}
            </p>
            <p className="hint">{latest.reason}</p>
            <p className="hint">
              {t('router.latencyLine', { ms: Math.round(latest.latencyMs) })}
              {latest.routeId ? ` · ${latest.routeId}` : ''}
            </p>
            {decisions.length > 1 && (
              <ul>
                {decisions.slice(1, 6).map((d, i) => (
                  <li key={`${d.at}-${i}`}>
                    {d.target.providerId}/{d.target.model} · {d.layer} · {d.reason}
                    {botFilter === 'all' ? ` · ${botName(d.botId)}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          !loading && <p className="hint">{t('router.empty')}</p>
        )}
        {decisions.length > 0 && (
          <button className="btn secondary" data-testid="router-clear-log" onClick={clearLog}>
            {t('router.clearLog')}
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * Providers the user can disable routing to: merged from discovered CLI/API
 * targets + engine status (even engines not offered yet — the user can still
 * disable them upfront). Local Ollama is always in the list.
 */
function collectProviderOptions(targets: RouterTargetsView | null): Array<{ id: string; label: string }> {
  const byId = new Map<string, string>();
  if (targets?.local) byId.set(targets.local.providerId, targets.local.providerId);
  for (const target of targets?.cli ?? []) byId.set(target.providerId, target.providerId);
  for (const target of targets?.api ?? []) byId.set(target.providerId, target.providerId);
  for (const s of targets?.cliStatus ?? []) byId.set(s.providerId, s.label);
  return [...byId.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
