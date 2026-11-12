import { useEffect, useMemo, useState } from 'react';
import type {
  McpMarketplaceProbeResultLike,
  McpMarketplaceServerLike,
  McpServerConfigLike,
  McpUpdateInfoLike,
  PluginDowngradeInfoLike,
  PluginMarketplaceViewLike,
  PreparedPluginLike,
  TrustedMarketplaceKeyLike,
} from '../types';
import { useT } from '../i18n/useT';
import ConfirmModal, { type PendingConfirm } from './ConfirmModal';
import {
  MARKETPLACE_ALL_TAGS,
  filterMarketplaceServers,
  marketplaceTags,
  toolParamSummary,
} from './mcpMarketplace';

type MarketplaceTab = 'mcp' | 'plugins';

interface Props {
  /** Bot currently selected; null means the user must pick a bot first. */
  botId: string | null;
  onBack: () => void;
}

/**
 * MCP marketplace (v0.3): browse the local catalogue of MCP servers and
 * install/uninstall them into the selected bot's workspace mcp.json.
 *
 * Credentials are never entered here: a server that needs a key only shows
 * a human-readable description of what is needed, and after install the
 * `nextSteps` tell the user to fill the key/path into mcp.json themselves.
 *
 * v0.67a: search box (diacritic-insensitive, name/description) + tag
 * filter chips, and a per-server "View tools" panel. Tools are probed
 * on demand only — one server per click, never the whole catalogue —
 * via `mcp-marketplace:tools`; the main process caches probe results
 * for the session. A server that needs a key is never probed.
 */
export default function McpMarketplaceView({ botId, onBack }: Props) {
  const t = useT();
  const [servers, setServers] = useState<McpMarketplaceServerLike[]>([]);
  const [installed, setInstalled] = useState<McpServerConfigLike[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Next-steps shown after a successful install, keyed by marketplace id. */
  const [nextSteps, setNextSteps] = useState<Record<string, string[]>>({});
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  /** Search query for the name/description filter (v0.67a). */
  const [query, setQuery] = useState('');
  /** Selected tag chip; MARKETPLACE_ALL_TAGS means "no tag filter". */
  const [selectedTag, setSelectedTag] = useState<string>(MARKETPLACE_ALL_TAGS);
  /** Server whose tools panel is open (at most one at a time). */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** Probe results per server id (ok / needs-key / error). */
  const [toolsById, setToolsById] = useState<Record<string, McpMarketplaceProbeResultLike>>({});
  /** Server id whose tools are currently being probed. */
  const [toolsLoadingId, setToolsLoadingId] = useState<string | null>(null);
  /** v0.84e: install-time args edits, keyed by server id — one arg per
      line. Absent means "untouched": the catalogue defaults are used.
      Env/keys are deliberately NOT editable here (the core install
      never writes them); the next-steps after install tell the user
      to add a credential to .open-bot/mcp.json instead. */
  const [argsDraft, setArgsDraft] = useState<Record<string, string>>({});
  /** v0.89a (Marketplace v2): active tab — MCP servers or plugins. */
  const [tab, setTab] = useState<MarketplaceTab>('mcp');
  /** v0.89a: update info per server id (from mcp-marketplace:check-updates). */
  const [updates, setUpdates] = useState<Record<string, McpUpdateInfoLike>>({});
  /** v0.89a: remote-catalog URL typed by the user (https, allowlisted host). */
  const [remoteUrl, setRemoteUrl] = useState('');
  const [remoteLoading, setRemoteLoading] = useState(false);
  /** v0.89a: remote entries merged into the list (source 'remote'). */
  const [remoteServers, setRemoteServers] = useState<McpMarketplaceServerLike[]>([]);
  /** v0.89a: installed plugins (plugin tab). */
  const [plugins, setPlugins] = useState<PluginMarketplaceViewLike[]>([]);
  const [pluginQuery, setPluginQuery] = useState('');
  /** v0.89a: source typed for a plugin install (URL / git URL / local path). */
  const [pluginSource, setPluginSource] = useState('');
  /** v0.89a: plugin staged by prepare (shown before the approval step). */
  const [preparedPlugin, setPreparedPlugin] = useState<PreparedPluginLike | null>(null);
  const [pluginBusy, setPluginBusy] = useState(false);
  /** v0.94a: downgrade info per plugin id (from downgrade-info; only
      fetched for rows whose list record names a previous version). */
  const [downgradeInfoById, setDowngradeInfoById] = useState<
    Record<string, PluginDowngradeInfoLike>
  >({});
  /** v0.94a: plugin id whose downgrade is currently running. */
  const [downgradeBusyId, setDowngradeBusyId] = useState<string | null>(null);
  /** v0.94a: trusted publisher keys. The IPC only ever returns the
      derived keyId + label + added date — no key material reaches
      this view, and none is shown. */
  const [trustedKeys, setTrustedKeys] = useState<TrustedMarketplaceKeyLike[]>([]);
  const [trustedKeysLoading, setTrustedKeysLoading] = useState(false);
  const [trustedKeysError, setTrustedKeysError] = useState('');
  /** v0.94a: new-key form drafts (public-key PEM textarea + optional label). */
  const [newKeyPem, setNewKeyPem] = useState('');
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [addKeyBusy, setAddKeyBusy] = useState(false);
  const [addKeyError, setAddKeyError] = useState('');
  /** v0.94a: key id whose removal is currently running. */
  const [removeKeyBusyId, setRemoveKeyBusyId] = useState<string | null>(null);

  /** Text shown in the args editor: the draft, or the defaults. */
  const argsText = (server: McpMarketplaceServerLike): string =>
    argsDraft[server.id] ?? (server.args ?? []).join('\n');

  /** One arg per line; blank lines are dropped, items are trimmed. */
  const parseArgs = (text: string): string[] =>
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

  const load = async (id: string) => {
    setLoading(true);
    setError('');
    try {
      const [available, installedList] = await Promise.all([
        window.openBot.listMcpMarketplace(),
        window.openBot.listMcpInstalled(id),
      ]);
      setServers(available);
      setInstalled(installedList);
      // v0.89a: update check is best-effort (older preload mocks in
      // tests may not expose it) — a failure here never blocks the list.
      if (typeof window.openBot.checkMcpUpdates === 'function') {
        try {
          const rows = await window.openBot.checkMcpUpdates(id);
          setUpdates(Object.fromEntries(rows.map((r) => [r.id, r])));
        } catch {
          // No update info; the list still renders without badges.
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('mcp.loadError'));
    } finally {
      setLoading(false);
    }
  };

  /** v0.89a: load the installed-plugin list (plugin tab, bot-independent). */
  const loadPlugins = async () => {
    if (typeof window.openBot.listPluginMarketplace !== 'function') return;
    try {
      const list = await window.openBot.listPluginMarketplace();
      setPlugins(list);
      // v0.94a: refresh which rows can actually downgrade (the
      // snapshot may have been removed since the last load).
      await loadDowngradeInfos(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('mcp.loadError'));
    }
  };

  /** v0.94a: fetch downgrade-info for every listed plugin that
      records a previous version. Best-effort per plugin: one bad row
      never blocks the others, and a missing IPC (older preload mock)
      leaves the list-driven fallback in place. */
  const loadDowngradeInfos = async (list: PluginMarketplaceViewLike[]) => {
    if (typeof window.openBot.getPluginDowngradeInfo !== 'function') return;
    const rows = list.filter((p) => p.previousVersion != null);
    if (rows.length === 0) return;
    const settled = await Promise.allSettled(
      rows.map((p) => window.openBot.getPluginDowngradeInfo(p.id)),
    );
    setDowngradeInfoById((prev) => {
      const next = { ...prev };
      settled.forEach((r, i) => {
        if (r.status === 'fulfilled') next[rows[i].id] = r.value;
      });
      return next;
    });
  };

  /** v0.94a: the version a Downgrade button would restore to, or null
      when the row must not offer one. Downgrade-info decides when it
      is known; before it loads (or when the IPC is missing) the list
      record's previousVersion is the fallback. A click always
      re-validates in main before anything changes. */
  const downgradeTargetOf = (plugin: PluginMarketplaceViewLike): string | null => {
    const info = downgradeInfoById[plugin.id];
    if (info) return info.canDowngrade ? info.previousVersion : null;
    return plugin.previousVersion ?? null;
  };

  /** v0.94a: load the trusted-keys store (public keys only). */
  const loadTrustedKeys = async () => {
    if (typeof window.openBot.listTrustedMarketplaceKeys !== 'function') return;
    setTrustedKeysLoading(true);
    setTrustedKeysError('');
    try {
      setTrustedKeys(await window.openBot.listTrustedMarketplaceKeys());
    } catch (e) {
      setTrustedKeysError(
        e instanceof Error ? e.message : t('plugin.trustedKeysLoadError'),
      );
    } finally {
      setTrustedKeysLoading(false);
    }
  };

  useEffect(() => {
    void loadPlugins();
    void loadTrustedKeys();
    // Plugin list loads once (bot-independent).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!botId) {
      setLoading(false);
      return;
    }
    void load(botId);
    // Load once per selected bot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId]);

  // Installed configs are keyed by marketplace id (config.name === entry.id).
  const isInstalled = (server: McpMarketplaceServerLike) =>
    installed.some((c) => c.name === server.id);

  /** v0.89a: catalogue + remote entries, for rendering. */
  const allServers = useMemo(
    () => [...servers, ...remoteServers.filter((r) => !servers.some((s) => s.id === r.id))],
    [servers, remoteServers],
  );

  const allTags = useMemo(() => marketplaceTags(allServers), [allServers]);
  const filtered = useMemo(
    () => filterMarketplaceServers(allServers, query, selectedTag),
    [allServers, query, selectedTag],
  );

  /** v0.89a: installed plugins matching the plugin search box. */
  const filteredPlugins = useMemo(() => {
    const q = pluginQuery.trim().toLowerCase();
    if (!q) return plugins;
    return plugins.filter((p) =>
      `${p.id} ${p.name} ${p.description}`.toLowerCase().includes(q),
    );
  }, [plugins, pluginQuery]);

  /** v0.89a: the remote entry for a server, when the row came from a remote catalog. */
  const remoteEntryOf = (server: McpMarketplaceServerLike) =>
    remoteServers.find((r) => r.id === server.id);

  /** v0.89a: update info for one server (undefined = no update known). */
  const updateOf = (server: McpMarketplaceServerLike) => updates[server.id];

  /** Human-readable source of a server (transport + command/args or URL). */
  const sourceOf = (server: McpMarketplaceServerLike): string => {
    if (server.transport === 'http') return `http · ${server.url ?? ''}`;
    const cmd = [server.command ?? '', ...(server.args ?? [])].join(' ').trim();
    return `stdio · ${cmd}`;
  };

  const toggleTools = async (server: McpMarketplaceServerLike) => {
    if (expandedId === server.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(server.id);
    // A previous probe result (cached in this view; the main process
    // also caches per session) is reused — no second probe.
    if (toolsById[server.id] || toolsLoadingId === server.id) return;
    setToolsLoadingId(server.id);
    try {
      const result = await window.openBot.listMcpServerTools(server.id);
      setToolsById((prev) => ({ ...prev, [server.id]: result }));
    } catch (e) {
      setToolsById((prev) => ({
        ...prev,
        [server.id]: {
          serverId: server.id,
          status: 'error',
          tools: [],
          truncated: false,
          error: e instanceof Error ? e.message : t('mcp.loadError'),
        },
      }));
    } finally {
      setToolsLoadingId(null);
    }
  };

  /** v0.89a: install asks for approval first — the decision is recorded
      in the main process, then the install runs (the main handler
      refuses without a recorded approval). */
  const install = (server: McpMarketplaceServerLike) => {
    if (!botId) return;
    setPendingConfirm({
      title: t('mcp.title'),
      message: t('mcp.approveInstallConfirm', {
        name: server.name,
        version: server.version ?? '?',
      }),
      confirmLabel: t('mcp.install'),
      onConfirm: () => void doInstall(server),
    });
  };

  const doInstall = async (server: McpMarketplaceServerLike) => {
    if (!botId) return;
    setBusyId(server.id);
    setError('');
    setNotice('');
    try {
      await window.openBot.approveMarketplace(
        'mcp-install',
        server.id,
        server.version,
        server.source ?? 'local',
      );
      // v0.84e: only send overrides when the user actually changed
      // the args — untouched servers install exactly as catalogued.
      const edited = parseArgs(argsText(server));
      const defaults = server.args ?? [];
      const changed =
        edited.length !== defaults.length ||
        edited.some((arg, i) => arg !== defaults[i]);
      const result = await window.openBot.installMcpServer(
        server.id,
        botId,
        changed ? edited : undefined,
        remoteEntryOf(server),
        server.version,
      );
      setInstalled((prev) =>
        prev.some((c) => c.name === server.id) ? prev : [...prev, result.config],
      );
      setNextSteps((prev) => ({ ...prev, [server.id]: result.nextSteps }));
      setNotice(t('mcp.installedOk', { name: server.name }));
      // Refresh update info: the just-installed version is now current.
      if (typeof window.openBot.checkMcpUpdates === 'function') {
        try {
          const rows = await window.openBot.checkMcpUpdates(botId);
          setUpdates(Object.fromEntries(rows.map((r) => [r.id, r])));
        } catch {
          // Ignore — the install itself succeeded.
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('mcp.loadError'));
    } finally {
      setBusyId(null);
    }
  };

  /** v0.89a: update to the latest catalogued version (approval first, like install). */
  const update = (server: McpMarketplaceServerLike) => {
    if (!botId) return;
    const info = updateOf(server);
    if (!info?.latestVersion) return;
    setPendingConfirm({
      title: t('mcp.title'),
      message: t('mcp.approveUpdateConfirm', { name: server.name, version: info.latestVersion }),
      confirmLabel: t('mcp.update'),
      onConfirm: () => void doUpdate(server, info.latestVersion as string),
    });
  };

  const doUpdate = async (server: McpMarketplaceServerLike, latestVersion: string) => {
    if (!botId) return;
    setBusyId(server.id);
    setError('');
    setNotice('');
    try {
      await window.openBot.approveMarketplace(
        'mcp-update',
        server.id,
        latestVersion,
        server.source ?? 'local',
      );
      const result = await window.openBot.updateMcpServer(server.id, botId, latestVersion);
      setNotice(t('mcp.updatedOk', { name: server.name, version: result.toVersion }));
      const rows = await window.openBot.checkMcpUpdates(botId);
      setUpdates(Object.fromEntries(rows.map((r) => [r.id, r])));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('mcp.loadError'));
    } finally {
      setBusyId(null);
    }
  };

  /** v0.89a: load a remote catalog (https, allowlisted host — enforced in main). */
  const loadRemoteCatalog = async () => {
    const url = remoteUrl.trim();
    if (!url) return;
    setRemoteLoading(true);
    setError('');
    setNotice('');
    try {
      const entries = await window.openBot.fetchRemoteMcpCatalog(url);
      setRemoteServers(entries);
      setNotice(t('mcp.remoteCatalogLoaded', { count: String(entries.length) }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('mcp.loadError'));
    } finally {
      setRemoteLoading(false);
    }
  };

  /** v0.89a: guess the plugin source kind from what the user typed. */
  const pluginSourceOf = (input: string): { kind: string; url?: string; path?: string } => {
    const trimmed = input.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      return /\.git(\/)?$/i.test(trimmed) || trimmed.startsWith('git+')
        ? { kind: 'git', url: trimmed }
        : { kind: 'url', url: trimmed };
    }
    return { kind: 'local', path: trimmed };
  };

  /** v0.89a: stage a plugin (download/validate only — nothing installed yet). */
  const preparePlugin = async () => {
    if (!pluginSource.trim()) return;
    setPluginBusy(true);
    setError('');
    setNotice('');
    try {
      const prepared = await window.openBot.preparePluginInstall(
        pluginSourceOf(pluginSource),
      );
      setPreparedPlugin(prepared);
    } catch (e) {
      setPreparedPlugin(null);
      setError(e instanceof Error ? e.message : t('mcp.loadError'));
    } finally {
      setPluginBusy(false);
    }
  };

  /** v0.89a: install the staged plugin (approval first, like MCP). */
  const doInstallPlugin = async (prepared: PreparedPluginLike) => {
    setPluginBusy(true);
    setError('');
    setNotice('');
    try {
      await window.openBot.approveMarketplace(
        'plugin-install',
        prepared.id,
        prepared.version,
        'marketplace',
      );
      await window.openBot.installPluginMarketplace(prepared.stagingId);
      setPreparedPlugin(null);
      setPluginSource('');
      setNotice(t('plugin.installedOk', { name: prepared.name }));
      await loadPlugins();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('mcp.loadError'));
    } finally {
      setPluginBusy(false);
    }
  };

  /** v0.89a: update an installed plugin from its recorded source. */
  const doUpdatePlugin = async (plugin: PluginMarketplaceViewLike) => {
    if (!plugin.source) return;
    setPluginBusy(true);
    setError('');
    setNotice('');
    try {
      const prepared = await window.openBot.preparePluginInstall(plugin.source);
      await window.openBot.approveMarketplace(
        'plugin-update',
        prepared.id,
        prepared.version,
        'marketplace',
      );
      await window.openBot.updatePluginMarketplace(prepared.stagingId);
      setNotice(t('plugin.updatedOk', { name: prepared.name }));
      await loadPlugins();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('mcp.loadError'));
    } finally {
      setPluginBusy(false);
    }
  };

  const doUninstallPlugin = async (plugin: PluginMarketplaceViewLike) => {
    setPluginBusy(true);
    setError('');
    setNotice('');
    try {
      await window.openBot.uninstallPluginMarketplace(plugin.id);
      setNotice(t('plugin.uninstalledOk', { name: plugin.name }));
      await loadPlugins();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('mcp.loadError'));
    } finally {
      setPluginBusy(false);
    }
  };

  /** v0.94a: downgrade asks for confirmation first (same ConfirmModal
      as install/update). The main handler re-validates fail-closed —
      snapshot on disk, signature still valid — so a stale info row
      can only produce a clear error here, never a fake success. */
  const downgrade = (plugin: PluginMarketplaceViewLike) => {
    const target = downgradeTargetOf(plugin);
    if (!target) return;
    setPendingConfirm({
      title: t('plugin.title'),
      message: t('plugin.downgradeConfirm', {
        name: plugin.name,
        fromVersion: plugin.version,
        toVersion: target,
      }),
      confirmLabel: t('plugin.downgrade'),
      onConfirm: () => void doDowngrade(plugin),
    });
  };

  const doDowngrade = async (plugin: PluginMarketplaceViewLike) => {
    setDowngradeBusyId(plugin.id);
    setError('');
    setNotice('');
    try {
      const result = await window.openBot.downgradePluginMarketplace(plugin.id);
      setNotice(
        t('plugin.downgradedOk', {
          name: plugin.name,
          fromVersion: result.fromVersion,
          toVersion: result.toVersion,
        }),
      );
      // Reload: the two versions swap roles after a downgrade, so the
      // info row (and the button) must be re-read, not just flipped.
      await loadPlugins();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('mcp.loadError'));
    } finally {
      setDowngradeBusyId(null);
    }
  };

  /** v0.94a: client-side PEM shape check — the main handler also
      rejects a bad PEM / non-Ed25519 key, but catching the obvious
      mistake here avoids a round-trip and explains the format. */
  const looksLikePublicKeyPem = (pem: string): boolean => {
    const trimmed = pem.trim();
    return (
      trimmed.startsWith('-----BEGIN PUBLIC KEY-----') &&
      trimmed.includes('-----END PUBLIC KEY-----')
    );
  };

  const doAddTrustedKey = async () => {
    const pem = newKeyPem.trim();
    if (!looksLikePublicKeyPem(pem)) {
      setAddKeyError(t('plugin.addKeyInvalidPem'));
      return;
    }
    setAddKeyBusy(true);
    setAddKeyError('');
    setError('');
    setNotice('');
    try {
      const result = await window.openBot.addTrustedMarketplaceKey(
        pem,
        newKeyLabel.trim() || undefined,
      );
      // Clear the PEM from the form as soon as it is stored — the key
      // lives in the trusted-keys store now, not in this view.
      setNewKeyPem('');
      setNewKeyLabel('');
      setNotice(t('plugin.addKeyOk', { keyId: result.keyId.slice(0, 16) }));
      await loadTrustedKeys();
    } catch (e) {
      setAddKeyError(
        e instanceof Error ? e.message : t('plugin.trustedKeysLoadError'),
      );
    } finally {
      setAddKeyBusy(false);
    }
  };

  const removeTrustedKey = (key: TrustedMarketplaceKeyLike) => {
    setPendingConfirm({
      title: t('plugin.trustedKeysTitle'),
      message: t('plugin.removeKeyConfirm', { label: key.label ?? key.keyId }),
      confirmLabel: t('plugin.removeKey'),
      onConfirm: () => void doRemoveTrustedKey(key),
    });
  };

  const doRemoveTrustedKey = async (key: TrustedMarketplaceKeyLike) => {
    setRemoveKeyBusyId(key.keyId);
    setError('');
    setNotice('');
    try {
      await window.openBot.removeTrustedMarketplaceKey(key.keyId);
      setNotice(t('plugin.removeKeyOk', { label: key.label ?? key.keyId }));
      await loadTrustedKeys();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('mcp.loadError'));
    } finally {
      setRemoveKeyBusyId(null);
    }
  };

  const uninstall = (server: McpMarketplaceServerLike) => {
    if (!botId) return;
    setPendingConfirm({
      title: t('mcp.title'),
      message: t('mcp.uninstallConfirm', { name: server.name }),
      confirmLabel: t('mcp.uninstall'),
      onConfirm: () => void doUninstall(server),
    });
  };

  const doUninstall = async (server: McpMarketplaceServerLike) => {
    if (!botId) return;
    setBusyId(server.id);
    setError('');
    setNotice('');
    try {
      await window.openBot.uninstallMcpServer(server.id, botId);
      setInstalled((prev) => prev.filter((c) => c.name !== server.id));
      setNextSteps((prev) => {
        const next = { ...prev };
        delete next[server.id];
        return next;
      });
      setNotice(t('mcp.uninstalledOk', { name: server.name }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('mcp.loadError'));
    } finally {
      setBusyId(null);
    }
  };

  // v0.89a: no bot selected only blocks the MCP tab (installs are
  // per-bot); the Plugins tab is global and still works.

  // v0.68c: the loading state keeps the Back button and the title —
  // the old early-return dropped them, so a slow load left the user
  // with no way back. The loading line carries a test id (v0.67b
  // pattern) so the renderer test can tell loading apart from empty.
  if (loading && botId) {
    return (
      <div className="panel">
        <button className="btn secondary" onClick={onBack}>{t('mcp.back')}</button>
        <h2>{t('mcp.title')}</h2>
        <p className="hint" data-testid="mcp-marketplace-loading">{t('mcp.loading')}</p>
      </div>
    );
  }

  return (
    <div className="panel">
      <button className="btn secondary" onClick={onBack}>{t('mcp.back')}</button>
      <h2>{t('mcp.title')}</h2>
      {/* v0.89a (Marketplace v2): MCP servers / Plugins tabs. */}
      <div className="row" role="tablist" aria-label={t('mcp.title')}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'mcp'}
          className={tab === 'mcp' ? 'btn' : 'btn secondary'}
          onClick={() => setTab('mcp')}
        >
          {t('mcp.mcpTab')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'plugins'}
          className={tab === 'plugins' ? 'btn' : 'btn secondary'}
          onClick={() => setTab('plugins')}
        >
          {t('mcp.pluginsTab')}
        </button>
      </div>
      {botId && <p className="hint">{t('mcp.forBot', { name: botId })}</p>}
      {!botId && tab === 'mcp' && <p className="empty">{t('mcp.selectBotFirst')}</p>}
      {/* v0.68c: a load/install/uninstall error shows a Retry button
          that reloads the list (same load() the view mounts with),
          instead of leaving a bare error line with no way forward. */}
      {error && (
        <>
          <p className="error">{error}</p>
          <button
            className="btn secondary"
            data-testid="mcp-marketplace-retry"
            disabled={!botId}
            onClick={() => botId && void load(botId)}
          >
            {t('mcp.retry')}
          </button>
        </>
      )}
      {notice && <p className="success">{notice}</p>}

      {tab === 'mcp' && botId && (
        <>
      {/* v0.89a (Marketplace v2): remote catalog (https, allowlisted host). */}
      <h3>{t('mcp.remoteCatalogTitle')}</h3>
      <div className="row">
        <input
          type="url"
          data-testid="mcp-remote-catalog-url"
          value={remoteUrl}
          onChange={(e) => setRemoteUrl(e.target.value)}
          placeholder={t('mcp.remoteCatalogUrlPlaceholder')}
          aria-label={t('mcp.remoteCatalogUrlPlaceholder')}
          style={{ flex: 1 }}
        />
        <button
          className="btn secondary"
          disabled={remoteLoading || !remoteUrl.trim()}
          onClick={() => void loadRemoteCatalog()}
        >
          {t('mcp.remoteCatalogLoad')}
        </button>
      </div>
      <p className="hint">{t('mcp.remoteCatalogHint')}</p>

      <h3>{t('mcp.availableTitle')}</h3>
      <input
        type="search"
        data-testid="mcp-marketplace-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('mcp.searchPlaceholder')}
        aria-label={t('mcp.searchPlaceholder')}
        style={{ width: '100%', marginBottom: 8 }}
      />
      <div className="row wrap" role="group" aria-label={t('mcp.filterByTag')}>
        <button
          type="button"
          className={selectedTag === MARKETPLACE_ALL_TAGS ? 'btn' : 'btn secondary'}
          aria-pressed={selectedTag === MARKETPLACE_ALL_TAGS}
          onClick={() => setSelectedTag(MARKETPLACE_ALL_TAGS)}
        >
          {t('mcp.allTags')}
        </button>
        {allTags.map((tag) => (
          <button
            key={tag}
            type="button"
            className={selectedTag === tag ? 'btn' : 'btn secondary'}
            aria-pressed={selectedTag === tag}
            onClick={() => setSelectedTag(tag)}
          >
            {tag}
          </button>
        ))}
      </div>
      {allServers.length === 0 && <p className="empty">{t('mcp.emptyAvailable')}</p>}
      {allServers.length > 0 && filtered.length === 0 && (
        <p className="empty">{t('mcp.noResults')}</p>
      )}
      {filtered.map((server) => {
        const installedNow = isInstalled(server);
        const steps = nextSteps[server.id] ?? [];
        const expanded = expandedId === server.id;
        const probe = toolsById[server.id];
        const probing = toolsLoadingId === server.id;
        const updateInfo = updateOf(server);
        return (
          <div key={server.id} className="card">
            <h3>
              {server.name}{' '}
              <span className="badge">{server.transport}</span>{' '}
              {server.version && server.version !== '0.0.0' && (
                <span className="badge">v{server.version}</span>
              )}{' '}
              {installedNow && <span className="badge done">{t('mcp.installed')}</span>}{' '}
              {installedNow && updateInfo?.updateAvailable && updateInfo.compatible && (
                <span className="badge">
                  {t('mcp.updateAvailable', { version: updateInfo.latestVersion ?? '' })}
                </span>
              )}
            </h3>
            <p>{server.description}</p>
            {server.changelog && (
              <p className="hint">{t('mcp.changelog', { text: server.changelog })}</p>
            )}
            {server.source === 'remote' && (
              <p className="hint">{t('mcp.remoteSource', { url: server.catalogUrl ?? '' })}</p>
            )}
            {server.command && (
              <p className="hint">
                {t('mcp.command')}{' '}
                <code>
                  {server.command}
                  {server.args && server.args.length > 0 ? ` ${server.args.join(' ')}` : ''}
                </code>
              </p>
            )}
            {server.url && (
              <p className="hint">
                <code>{server.url}</code>
              </p>
            )}
            {server.needsKey && (
              <p className="hint">🔑 {t('mcp.needsKey', { description: server.needsKey })}</p>
            )}
            {!installedNow && server.command && (
              <div className="field" style={{ marginTop: 8 }}>
                <label htmlFor={`mcp-args-${server.id}`}>{t('mcp.argsLabel')}</label>
                <textarea
                  id={`mcp-args-${server.id}`}
                  data-testid={`mcp-args-${server.id}`}
                  value={argsText(server)}
                  onChange={(e) =>
                    setArgsDraft((prev) => ({ ...prev, [server.id]: e.target.value }))
                  }
                  rows={Math.min(6, Math.max(2, argsText(server).split('\n').length))}
                  style={{ width: '100%' }}
                />
                <p className="hint">{t('mcp.argsHint')}</p>
              </div>
            )}
            <div className="row wrap">
              {server.tags.map((tag) => (
                <span key={tag} className="badge">{tag}</span>
              ))}
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              {installedNow ? (
                <button
                  className="btn secondary"
                  disabled={busyId === server.id}
                  onClick={() => void uninstall(server)}
                >
                  {t('mcp.uninstall')}
                </button>
              ) : (
                <button
                  className="btn"
                  disabled={busyId === server.id}
                  onClick={() => void install(server)}
                >
                  {t('mcp.install')}
                </button>
              )}
              {installedNow && updateInfo?.updateAvailable && updateInfo.compatible && (
                <button
                  className="btn"
                  disabled={busyId === server.id}
                  onClick={() => void update(server)}
                >
                  {t('mcp.update')}
                </button>
              )}
              {installedNow && updateInfo?.updateAvailable && !updateInfo.compatible && (
                <span className="hint">
                  {t('mcp.updateIncompatible', { version: updateInfo.minAppVersion ?? '' })}
                </span>
              )}
              <button
                className="btn secondary"
                disabled={probing}
                onClick={() => void toggleTools(server)}
              >
                {expanded ? t('mcp.hideTools') : t('mcp.viewTools')}
              </button>
            </div>
            {expanded && (
              <div style={{ marginTop: 8 }}>
                <p className="hint">{t('mcp.toolsSource', { source: sourceOf(server) })}</p>
                {probing && <p>{t('mcp.toolsLoading')}</p>}
                {!probing && probe?.status === 'needs-key' && (
                  <p className="hint">{t('mcp.toolsNeedsKey')}</p>
                )}
                {!probing && probe?.status === 'error' && (
                  <p className="error">
                    {t('mcp.toolsLoadError', { message: probe.error ?? '' })}
                  </p>
                )}
                {!probing && probe?.status === 'ok' && probe.tools.length === 0 && (
                  <p className="empty">{t('mcp.toolsEmpty')}</p>
                )}
                {/* v0.73: a -32602 tools/list rejection still probes
                    'ok' with no tools — show the warning the probe
                    collected so the empty list is explained instead
                    of looking like a server with no tools. */}
                {!probing && probe?.status === 'ok' && (probe.warnings ?? []).map((w) => (
                  <p key={`${w.method}-${w.code}`} className="hint" data-testid="marketplace-probe-warning">
                    {w.message}
                  </p>
                ))}
                {!probing && probe?.status === 'ok' && probe.tools.length > 0 && (
                  <div>
                    <strong>{t('mcp.toolsTitle', { count: String(probe.tools.length) })}</strong>
                    {probe.truncated && <p className="hint">{t('mcp.toolsTruncated')}</p>}
                    {probe.tools.map((tool) => {
                      const { paramNames, required } = toolParamSummary(tool);
                      return (
                        <div key={tool.name} className="card" style={{ marginTop: 8 }}>
                          <code>{tool.name}</code>
                          {tool.description && <p>{tool.description}</p>}
                          {paramNames.length === 0 ? (
                            <p className="hint">{t('mcp.toolsNoParams')}</p>
                          ) : (
                            <p className="hint">
                              {t('mcp.toolsParams')} <code>{paramNames.join(', ')}</code>
                              {required.length > 0 && (
                                <> ({t('mcp.toolsRequired', { names: required.join(', ') })})</>
                              )}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {steps.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <strong>{t('mcp.nextStepsTitle')}</strong>
                <ol>
                  {steps.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
                <p className="hint">{t('mcp.nextStepsHint')}</p>
              </div>
            )}
          </div>
        );
      })}
        </>
      )}

      {tab === 'plugins' && (
        <>
          <h3>{t('plugin.title')}</h3>
          <p className="hint">{t('plugin.sandboxHint')}</p>
          <input
            type="search"
            data-testid="plugin-marketplace-search"
            value={pluginQuery}
            onChange={(e) => setPluginQuery(e.target.value)}
            placeholder={t('plugin.searchPlaceholder')}
            aria-label={t('plugin.searchPlaceholder')}
            style={{ width: '100%', marginBottom: 8 }}
          />
          <div className="field">
            <label htmlFor="plugin-source">{t('plugin.sourceLabel')}</label>
            <input
              id="plugin-source"
              data-testid="plugin-marketplace-source"
              type="text"
              value={pluginSource}
              onChange={(e) => setPluginSource(e.target.value)}
              placeholder={t('plugin.sourcePlaceholder')}
              style={{ width: '100%' }}
            />
            <p className="hint">{t('plugin.sourceHint')}</p>
          </div>
          <div className="row">
            <button
              className="btn secondary"
              disabled={pluginBusy || !pluginSource.trim()}
              onClick={() => void preparePlugin()}
            >
              {t('plugin.checkSource')}
            </button>
          </div>
          {preparedPlugin && (
            <div className="card" data-testid="plugin-marketplace-prepared">
              <h3>{preparedPlugin.name} <span className="badge">v{preparedPlugin.version}</span></h3>
              <p>{preparedPlugin.description}</p>
              {preparedPlugin.author && (
                <p className="hint">{t('plugin.author', { name: preparedPlugin.author })}</p>
              )}
              <p className="hint">{t('plugin.approvalNote')}</p>
              <div className="row">
                <button
                  className="btn"
                  disabled={pluginBusy}
                  onClick={() => void doInstallPlugin(preparedPlugin)}
                >
                  {t('plugin.install')}
                </button>
                <button
                  className="btn secondary"
                  onClick={() => setPreparedPlugin(null)}
                >
                  {t('plugin.cancel')}
                </button>
              </div>
            </div>
          )}
          {plugins.length === 0 && <p className="empty">{t('plugin.empty')}</p>}
          {plugins.length > 0 && filteredPlugins.length === 0 && (
            <p className="empty">{t('mcp.noResults')}</p>
          )}
          {filteredPlugins.map((plugin) => {
            // v0.94a: the downgrade target (null = no button) and the
            // info row that explains why when a previous version was
            // recorded but cannot be restored.
            const downgradeTarget = downgradeTargetOf(plugin);
            const downgradeInfo = downgradeInfoById[plugin.id];
            return (
            <div key={plugin.id} className="card">
              <h3>
                {plugin.name}{' '}
                <span className="badge">v{plugin.version}</span>{' '}
                {plugin.sandboxed && <span className="badge done">{t('plugin.sandboxed')}</span>}{' '}
                {!plugin.enabled && <span className="badge">{t('plugin.disabled')}</span>}
              </h3>
              <p>{plugin.description}</p>
              {plugin.tools.length > 0 && (
                <p className="hint">
                  {t('plugin.tools', { names: plugin.tools.join(', ') })}
                </p>
              )}
              {downgradeTarget && (
                <p className="hint">
                  {t('plugin.downgradeAvailable', { version: downgradeTarget })}
                </p>
              )}
              {!downgradeTarget &&
                plugin.previousVersion != null &&
                downgradeInfo &&
                !downgradeInfo.canDowngrade && (
                  <p className="hint">
                    {t('plugin.downgradeUnavailable', {
                      reason: downgradeInfo.reason ?? '',
                    })}
                  </p>
                )}
              <div className="row" style={{ marginTop: 8 }}>
                {plugin.source && (
                  <button
                    className="btn"
                    disabled={pluginBusy}
                    onClick={() => void doUpdatePlugin(plugin)}
                  >
                    {t('plugin.update')}
                  </button>
                )}
                {downgradeTarget && (
                  <button
                    className="btn secondary"
                    data-testid={`plugin-downgrade-${plugin.id}`}
                    disabled={pluginBusy || downgradeBusyId === plugin.id}
                    onClick={() => void downgrade(plugin)}
                  >
                    {downgradeBusyId === plugin.id
                      ? t('mcp.loading')
                      : t('plugin.downgrade')}
                  </button>
                )}
                <button
                  className="btn secondary"
                  disabled={pluginBusy}
                  onClick={() => void doUninstallPlugin(plugin)}
                >
                  {t('plugin.uninstall')}
                </button>
              </div>
            </div>
            );
          })}
          {/* v0.94a: trusted publisher keys (public keys only — the
              store never holds a private key, and this section never
              shows key material, only the derived keyId + label). */}
          <h3>{t('plugin.trustedKeysTitle')}</h3>
          <p className="hint">{t('plugin.trustedKeysHint')}</p>
          <div data-testid="plugin-trusted-keys">
            {trustedKeysLoading && (
              <p className="hint" data-testid="plugin-trusted-keys-loading">
                {t('plugin.trustedKeysLoading')}
              </p>
            )}
            {!trustedKeysLoading && trustedKeysError && (
              <>
                <p className="error">{trustedKeysError}</p>
                <button
                  className="btn secondary"
                  data-testid="plugin-trusted-keys-retry"
                  onClick={() => void loadTrustedKeys()}
                >
                  {t('mcp.retry')}
                </button>
              </>
            )}
            {!trustedKeysLoading && !trustedKeysError && trustedKeys.length === 0 && (
              <p className="empty">{t('plugin.trustedKeysEmpty')}</p>
            )}
            {trustedKeys.map((key) => (
              <div key={key.keyId} className="card">
                <p>
                  <strong>{key.label ?? key.keyId}</strong>
                </p>
                <p className="hint">
                  <code>{key.keyId}</code>
                </p>
                <p className="hint">
                  {t('plugin.trustedKeyAddedAt', {
                    date: new Date(key.addedAt).toLocaleDateString(),
                  })}
                </p>
                <div className="row">
                  <button
                    className="btn secondary"
                    data-testid={`plugin-remove-key-${key.keyId}`}
                    disabled={removeKeyBusyId === key.keyId}
                    onClick={() => void removeTrustedKey(key)}
                  >
                    {t('plugin.removeKey')}
                  </button>
                </div>
              </div>
            ))}
          </div>
          <h4>{t('plugin.addKeyTitle')}</h4>
          <div className="field">
            <label htmlFor="plugin-new-key-pem">{t('plugin.addKeyPemLabel')}</label>
            <textarea
              id="plugin-new-key-pem"
              data-testid="plugin-add-key-pem"
              value={newKeyPem}
              onChange={(e) => setNewKeyPem(e.target.value)}
              placeholder={t('plugin.addKeyPemPlaceholder')}
              rows={4}
              style={{ width: '100%' }}
            />
          </div>
          <div className="field">
            <label htmlFor="plugin-new-key-label">{t('plugin.addKeyLabelLabel')}</label>
            <input
              id="plugin-new-key-label"
              data-testid="plugin-add-key-label"
              type="text"
              value={newKeyLabel}
              onChange={(e) => setNewKeyLabel(e.target.value)}
              placeholder={t('plugin.addKeyLabelPlaceholder')}
              style={{ width: '100%' }}
            />
          </div>
          {addKeyError && <p className="error">{addKeyError}</p>}
          <div className="row">
            <button
              className="btn"
              data-testid="plugin-add-key-button"
              disabled={addKeyBusy || !newKeyPem.trim()}
              onClick={() => void doAddTrustedKey()}
            >
              {t('plugin.addKeyButton')}
            </button>
          </div>
        </>
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
