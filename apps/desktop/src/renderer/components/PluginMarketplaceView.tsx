import { useCallback, useEffect, useState } from 'react';
import type { PermissionReviewView, PluginCatalogEntryView } from '../types';
import { useT } from '../i18n/useT';

/**
 * Plugin marketplace — browse installed plugins and installable
 * templates, with a permission review before installing.
 *
 * Data flows over IPC `plugin-marketplace:catalog` (installed plugins
 * + templates merged, installed wins) and `plugin-marketplace:review`
 * (core permission review: every declared permission with a risk
 * level; unknown permissions are high risk, never silently dropped).
 * Enable/disable uses the existing `plugins:toggle` IPC and install
 * from a template uses the existing `plugin-templates:apply` IPC, so
 * there is exactly one writer for plugin state.
 */

/** Call a window.openBot method by IPC channel, falling back to camelCase. */
async function callOpenBot<T>(channel: string, camel: string, ...args: unknown[]): Promise<T | null> {
  const api = window.openBot as unknown as Record<string, unknown>;
  const fn = api[channel] ?? api[camel];
  if (typeof fn !== 'function') return null;
  return (fn as (...a: unknown[]) => Promise<T>).apply(window.openBot, args);
}

function permLabel(t: (key: string, vars?: Record<string, string | number>) => string, permission: string): string {
  if (permission === 'fs') return t('pluginMarketplace.permFs');
  if (permission === 'shell') return t('pluginMarketplace.permShell');
  if (permission === 'network') return t('pluginMarketplace.permNetwork');
  if (permission === 'mcp') return t('pluginMarketplace.permMcp');
  return t('pluginMarketplace.permUnknown');
}

function riskLabel(t: (key: string, vars?: Record<string, string | number>) => string, risk: string): string {
  if (risk === 'high') return t('pluginMarketplace.riskHigh');
  if (risk === 'medium') return t('pluginMarketplace.riskMedium');
  return t('pluginMarketplace.riskLow');
}

type SourceFilter = 'all' | 'installed' | 'template';

interface Props {
  onBack: () => void;
}

export default function PluginMarketplaceView({ onBack }: Props) {
  const t = useT();
  const [entries, setEntries] = useState<PluginCatalogEntryView[]>([]);
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [review, setReview] = useState<{ reviews: PermissionReviewView[]; risk: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const catalog = await callOpenBot<PluginCatalogEntryView[]>(
        'plugin-marketplace:catalog',
        'listPluginMarketplaceCatalog',
      );
      if (!catalog) {
        setError(t('pluginMarketplace.loadError'));
        return;
      }
      setEntries(catalog);
    } catch (err) {
      setError((err as Error).message || t('pluginMarketplace.loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = entries.find((e) => e.id === selectedId) ?? null;

  async function handleSelect(entry: PluginCatalogEntryView) {
    setSelectedId(entry.id);
    setActionError(null);
    try {
      const result = await callOpenBot<{ reviews: PermissionReviewView[]; risk: string }>(
        'plugin-marketplace:review',
        'reviewPluginMarketplacePermissions',
        entry.permissions,
      );
      setReview(result);
    } catch {
      setReview(null);
    }
  }

  async function handleToggle(entry: PluginCatalogEntryView) {
    setActionError(null);
    setNotice(null);
    setBusyId(entry.id);
    try {
      const result = await callOpenBot<{ id: string; enabled: boolean }>(
        'plugins:toggle',
        'togglePlugin',
        { id: entry.id, enabled: !(entry.enabled ?? false) },
      );
      if (!result) throw new Error(t('pluginMarketplace.toggleError'));
      setEntries((prev) => prev.map((e) => (e.id === entry.id ? { ...e, enabled: result.enabled } : e)));
    } catch (err) {
      setActionError((err as Error).message || t('pluginMarketplace.toggleError'));
    } finally {
      setBusyId(null);
    }
  }

  async function handleInstall(entry: PluginCatalogEntryView) {
    setActionError(null);
    setNotice(null);
    setBusyId(entry.id);
    try {
      const result = await callOpenBot<unknown>('plugin-templates:apply', 'applyPluginTemplate', {
        id: entry.id,
      });
      if (!result) throw new Error(t('pluginMarketplace.installError'));
      setNotice(t('plugin.installedOk', { name: entry.name }));
      await load();
    } catch (err) {
      setActionError((err as Error).message || t('pluginMarketplace.installError'));
    } finally {
      setBusyId(null);
    }
  }

  const filtered = entries.filter((entry) => {
    if (sourceFilter !== 'all' && entry.source !== sourceFilter) return false;
    if (query.trim()) {
      const haystack = `${entry.name} ${entry.description} ${entry.id}`.toLowerCase();
      if (!query.trim().toLowerCase().split(/\s+/).every((word) => haystack.includes(word))) return false;
    }
    return true;
  });

  return (
    <div>
      <div className="row" style={{ alignItems: 'center', gap: 8 }}>
        <button className="btn secondary" onClick={onBack}>
          {t('marketplace.back')}
        </button>
        <h2 style={{ margin: 0, flex: 1 }}>{t('pluginMarketplace.title')}</h2>
        <button className="btn secondary" onClick={() => void load()} disabled={loading}>
          {t('fleet.refresh')}
        </button>
      </div>
      <p style={{ color: '#666', marginTop: 4 }}>{t('pluginMarketplace.subtitle')}</p>

      <div className="row" style={{ gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('plugin.searchPlaceholder')}
          style={{ flex: 1, minWidth: 180 }}
        />
        <label>
          <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value as SourceFilter)}>
            <option value="all">{t('botMarketplace.categoryAll')}</option>
            <option value="installed">{t('pluginMarketplace.installed')}</option>
            <option value="template">{t('pluginMarketplace.available')}</option>
          </select>
        </label>
      </div>

      {loading && <p>{t('marketplace.loading')}</p>}
      {error && <p style={{ color: '#c00' }}>{error}</p>}
      {notice && <p style={{ color: '#080' }}>{notice}</p>}
      {actionError && <p style={{ color: '#c00' }}>{actionError}</p>}

      {!loading && !error && filtered.length === 0 && <p>{t('pluginMarketplace.noResults')}</p>}
      {!loading &&
        !error &&
        filtered.map((entry) => (
          <div
            key={entry.id}
            onClick={() => void handleSelect(entry)}
            style={{
              border: selectedId === entry.id ? '2px solid #888' : '1px solid #ddd',
              borderRadius: 8,
              padding: 12,
              marginBottom: 10,
              cursor: 'pointer',
            }}
          >
            <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
              <strong>{entry.name}</strong>
              <span style={{ color: '#666', fontSize: 13 }}>
                {t('pluginMarketplace.version', { version: entry.version })} ·{' '}
                {entry.source === 'installed' ? t('pluginMarketplace.installed') : t('pluginMarketplace.available')}
              </span>
            </div>
            <p style={{ margin: '4px 0', color: '#444' }}>{entry.description}</p>
            <div style={{ color: '#666', fontSize: 13 }}>
              {entry.author ? `${t('marketplace.author', { author: entry.author })} · ` : ''}
              {entry.source === 'installed'
                ? entry.enabled === true
                  ? t('pluginMarketplace.enabled')
                  : t('plugin.disabled')
                : entry.hasEntry
                  ? ''
                  : t('pluginMarketplace.noEntry')}
            </div>
            <div style={{ marginTop: 6, fontSize: 13 }}>
              {t('pluginMarketplace.permissions')}:{' '}
              {entry.permissions.length === 0
                ? '—'
                : entry.permissions.map((p) => permLabel(t, p)).join(', ')}
            </div>
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              {entry.source === 'installed' ? (
                <button
                  className="btn secondary"
                  disabled={busyId === entry.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleToggle(entry);
                  }}
                >
                  {entry.enabled ? t('pluginMarketplace.disable') : t('pluginMarketplace.enable')}
                </button>
              ) : (
                <button
                  className="btn"
                  disabled={busyId === entry.id || !entry.hasEntry}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleInstall(entry);
                  }}
                >
                  {t('plugin.install')}
                </button>
              )}
            </div>
          </div>
        ))}

      {selected && review && (
        <div style={{ border: '1px solid #aaa', borderRadius: 8, padding: 12, marginTop: 4 }}>
          <strong>
            {t('pluginMarketplace.permissionReview')} {selected.name}
          </strong>{' '}
          <span
            style={{
              fontSize: 13,
              color: review.risk === 'high' ? '#c00' : review.risk === 'medium' ? '#c80' : '#080',
            }}
          >
            ({riskLabel(t, review.risk)})
          </span>
          {review.reviews.length === 0 && <p style={{ marginBottom: 0 }}>—</p>}
          {review.reviews.map((r) => (
            <div key={r.permission} style={{ marginTop: 6, fontSize: 14 }}>
              <strong>{permLabel(t, r.permission)}</strong> ·{' '}
              <span style={{ color: r.risk === 'high' ? '#c00' : r.risk === 'medium' ? '#c80' : '#080' }}>
                {riskLabel(t, r.risk)}
              </span>
              <div style={{ color: '#555', fontSize: 13 }}>{r.summary}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
