/**
 * RouterPanel — view + tune the per-turn model router (v0.96, Team T3).
 *
 * Shows the most recent decision (chosen model, deciding layer,
 * reason, latency), local-vs-cloud stats + estimated savings,
 * and lets the user tune thresholds + enable/disable each layer.
 *
 * v0.96 scope note: the panel reads decisions/stats via props (the
 * main process pushes them over IPC `router:decisions` /
 * `router:stats` — see docs/router-v096.md, "Remaining IPC wiring");
 * with no data yet it shows an empty state and never invents
 * numbers. Thresholds + layer toggles live in the renderer's
 * localStorage (`open-bot:router-panel:v1`) so they survive a
 * reopen; pushing the config down to the coordinator over IPC is
 * the next step (documented, deliberately not half-done here).
 */
import { useEffect, useState } from 'react';
import type { TFunction } from '../i18n/useT';

/** View shape of one routing decision (matches RoutingDecision in core). */
export interface RouterDecisionView {
  target: string;
  layer: string;
  routeId: string | null;
  reason: string;
  latencyMs: number;
  pinned: boolean;
  at: number;
}

export interface RouterStatsView {
  totalDecisions: number;
  localTurns: number;
  cloudTurns: number;
  estimatedSavingsUsd: number;
  avgLatencyMs: number;
}

interface Props {
  t: TFunction;
  /** Most recent decisions first (newest first). */
  decisions?: RouterDecisionView[];
  stats?: RouterStatsView | null;
}

export interface RouterPanelSettings {
  enabled: boolean;
  simpleMax: number;
  complexMin: number;
  layers: { structural: boolean; semantic: boolean; decision: boolean };
}

const STORAGE_KEY = 'open-bot:router-panel:v1';

export const DEFAULT_ROUTER_PANEL_SETTINGS: RouterPanelSettings = {
  enabled: true,
  simpleMax: 0.15,
  complexMin: 0.3,
  layers: { structural: true, semantic: true, decision: true },
};

function loadSettings(): RouterPanelSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_ROUTER_PANEL_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<RouterPanelSettings>;
    return {
      ...DEFAULT_ROUTER_PANEL_SETTINGS,
      ...parsed,
      layers: { ...DEFAULT_ROUTER_PANEL_SETTINGS.layers, ...(parsed.layers ?? {}) },
    };
  } catch {
    return DEFAULT_ROUTER_PANEL_SETTINGS;
  }
}

export default function RouterPanel({ t, decisions = [], stats = null }: Props) {
  const [settings, setSettings] = useState<RouterPanelSettings>(loadSettings);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // localStorage full / blocked: settings live only for this session.
    }
  }, [settings]);

  const latest = decisions[0];
  const setLayer = (layer: keyof RouterPanelSettings['layers'], on: boolean) =>
    setSettings((s) => ({ ...s, layers: { ...s.layers, [layer]: on } }));

  return (
    <section data-section="router" className="card">
      <h3>{t('router.title')}</h3>
      <p className="hint">{t('router.hint')}</p>

      <label>
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) => setSettings((s) => ({ ...s, enabled: e.target.checked }))}
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
            value={settings.simpleMax}
            disabled={!settings.enabled}
            onChange={(e) =>
              setSettings((s) => ({
                ...s,
                simpleMax: Math.min(1, Math.max(0, Number(e.target.value) || 0)),
              }))
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
            value={settings.complexMin}
            disabled={!settings.enabled}
            onChange={(e) =>
              setSettings((s) => ({
                ...s,
                complexMin: Math.min(1, Math.max(0, Number(e.target.value) || 0)),
              }))
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
              checked={settings.layers[layer]}
              disabled={!settings.enabled}
              onChange={(e) => setLayer(layer, e.target.checked)}
            />
            {t(`router.layer.${layer}`)}
          </label>
        ))}
      </fieldset>

      {stats && (
        <p className="router-stats">
          {t('router.statsLine', {
            local: stats.localTurns,
            cloud: stats.cloudTurns,
            saved: stats.estimatedSavingsUsd.toFixed(4),
            latency: Math.round(stats.avgLatencyMs),
          })}
        </p>
      )}

      {latest ? (
        <div className="router-latest">
          <p>
            <strong>{latest.target}</strong>{' '}
            <span className="badge">{latest.layer}</span>{' '}
            {latest.pinned && <span className="badge">{t('router.pinnedBadge')}</span>}
          </p>
          <p className="hint">{latest.reason}</p>
          <p className="hint">
            {t('router.latencyLine', { ms: Math.round(latest.latencyMs) })}
            {latest.routeId ? ` · ${latest.routeId}` : ''}
          </p>
          {decisions.length > 1 && (
            <ul className="router-history">
              {decisions.slice(1, 6).map((d, i) => (
                <li key={`${d.at}-${i}`}>
                  {d.target} · {d.layer} · {d.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <p className="hint">{t('router.empty')}</p>
      )}
    </section>
  );
}
