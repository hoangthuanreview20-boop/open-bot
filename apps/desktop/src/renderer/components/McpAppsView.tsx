import { useCallback, useEffect, useState } from 'react';
import type { McpAppFullViewLike, McpAppViewLike } from '../types';
import { useT } from '../i18n/useT';
import { MCP_APP_SANDBOX, SAMPLE_APP_HTML, buildRendererAppSrcdoc, formatAppBytes } from './mcpApps';

interface Props {
  onBack: () => void;
}

/**
 * MCP Apps view (v0.98, wave T6): list the interactive apps a server
 * returned and render the selected one in a sandboxed iframe.
 *
 * Safety: the iframe always uses sandbox="allow-scripts" (no
 * allow-same-origin, no top navigation, no forms, no popups) and a
 * strict CSP is baked into the srcDoc document (see mcpApps.ts, which
 * mirrors packages/core/src/mcp/apps.ts). The app HTML itself is never
 * written to disk — it lives in main-process memory only.
 */
export default function McpAppsView({ onBack }: Props) {
  const t = useT();
  const [apps, setApps] = useState<McpAppViewLike[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<McpAppFullViewLike | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (typeof window.openBot.listMcpApps !== 'function') {
      setLoading(false);
      setError(t('mcpApps.openFailed', { message: 'listMcpApps' }));
      return;
    }
    try {
      setApps(await window.openBot.listMcpApps());
    } catch (err) {
      setError(t('mcpApps.openFailed', { message: (err as Error).message }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (typeof window.openBot.onMcpAppsChanged !== 'function') return undefined;
    return window.openBot.onMcpAppsChanged((next) => {
      setApps(next);
      setSelectedId((current) =>
        current !== null && next.some((a) => a.id === current) ? current : null,
      );
    });
  }, []);

  useEffect(() => {
    if (selectedId === null) {
      setSelected(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const full = await window.openBot.getMcpApp(selectedId);
        if (!cancelled) setSelected(full);
      } catch (err) {
        if (!cancelled) setError(t('mcpApps.openFailed', { message: (err as Error).message }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, t]);

  const openSample = async () => {
    if (typeof window.openBot.openMcpApp !== 'function') return;
    setBusy(true);
    setError('');
    try {
      const opened = await window.openBot.openMcpApp({
        serverName: 'open-bot',
        title: t('mcpApps.sampleTitle'),
        html: SAMPLE_APP_HTML,
        origin: 'sample',
      });
      setSelectedId(opened.id);
      await refresh();
    } catch (err) {
      setError(t('mcpApps.openFailed', { message: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const closeApp = async (id: string) => {
    if (typeof window.openBot.closeMcpApp !== 'function') return;
    setBusy(true);
    setError('');
    try {
      await window.openBot.closeMcpApp(id);
      if (selectedId === id) setSelectedId(null);
      await refresh();
    } catch (err) {
      setError(t('mcpApps.closeFailed', { message: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>{t('mcpApps.title')}</h2>
        <button className="btn secondary" onClick={onBack}>{t('mcp.back')}</button>
      </div>
      <p style={{ color: 'var(--text-dim)', margin: '4px 0 12px' }}>{t('mcpApps.sandboxNote')}</p>
      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <button className="btn secondary" onClick={() => void refresh()} disabled={loading}>
          {loading ? t('mcpApps.loading') : t('mcpApps.refresh')}
        </button>
        <button className="btn secondary" onClick={() => void openSample()} disabled={busy}>
          {t('mcpApps.openSample')}
        </button>
        <span style={{ color: 'var(--text-dim)' }}>{t('mcpApps.appsCount', { count: String(apps.length) })}</span>
      </div>
      {error !== '' && <p className="error">{error}</p>}
      {loading ? (
        <p className="empty">{t('mcpApps.loading')}</p>
      ) : apps.length === 0 ? (
        <p className="empty">
          {t('mcpApps.empty')}
          <br />
          {t('mcpApps.emptyHint')}
        </p>
      ) : (
        <ul className="task-list">
          {apps.map((app) => (
            <li key={app.id}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <button
                  className="btn secondary"
                  style={{ textAlign: 'left' }}
                  onClick={() => setSelectedId(app.id)}
                >
                  <strong>{app.title}</strong>
                </button>
                <button className="btn secondary" onClick={() => void closeApp(app.id)} disabled={busy}>
                  {t('mcpApps.close')}
                </button>
              </div>
              <p style={{ margin: '6px 0 0', color: 'var(--text-dim)' }}>
                {t('mcpApps.server', { name: app.serverName })}
                {app.toolName ? ` · ${t('mcpApps.tool', { name: app.toolName })}` : ''} ·{' '}
                {t('mcpApps.size', { size: formatAppBytes(app.htmlBytes) })} ·{' '}
                {t(`mcpApps.origin.${app.origin}`)}
              </p>
            </li>
          ))}
        </ul>
      )}
      {selectedId !== null && (
        <div style={{ marginTop: 16 }}>
          {selected === null ? (
            <p className="empty">{t('mcpApps.loading')}</p>
          ) : (
            <>
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
                <h3 style={{ margin: 0 }}>{selected.title}</h3>
                <button className="btn secondary" onClick={() => setSelectedId(null)}>
                  {t('mcpApps.close')}
                </button>
              </div>
              <iframe
                title={selected.title}
                sandbox={MCP_APP_SANDBOX}
                srcDoc={buildRendererAppSrcdoc(selected.title, selected.html)}
                style={{ width: '100%', height: 420, border: '1px solid var(--border)', borderRadius: 8 }}
              />
            </>
          )}
        </div>
      )}
      {selectedId === null && apps.length > 0 && (
        <p className="empty">{t('mcpApps.selectHint')}</p>
      )}
    </div>
  );
}
