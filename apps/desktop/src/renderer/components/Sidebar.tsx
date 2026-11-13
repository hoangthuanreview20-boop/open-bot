import { useEffect, useState } from 'react';
import type { BotConfigLike, ThreadSearchHitView, ThreadView } from '../types';
import { useT } from '../i18n/useT';
import { filterBots } from './botList';
import { botColor, botInitial } from './botColors';
import {
  hiddenBots as getHiddenBots,
  sortBots,
  type BotMetaMap,
} from './botManager';

interface Props {
  bots: BotConfigLike[];
  selectedBotId: string | null;
  onSelect: (botId: string) => void;
  onCreate: () => void;
  onEdit: (bot: BotConfigLike) => void;
  onDelete: (bot: BotConfigLike) => void;
  onClone: (bot: BotConfigLike) => void;
  onOpenSettings: () => void;
  onOpenMarketplace: () => void;
  onOpenMcpMarketplace: () => void;
  // v0.98 (T6): MCP Apps (sandboxed iframe) + MCP Tasks (long-running).
  onOpenMcpApps: () => void;
  onOpenMcpTasks: () => void;
  onOpenA2a: () => void;
  onOpenTeam: () => void;
  // v0.96 (T6): dashboard + planner (plan flow) destinations.
  onOpenDashboard: () => void;
  onOpenPlanner: () => void;
  // v0.96 (T6): per-bot UI state (pin / unread / hide) — App owns
  // the meta map; the sidebar only renders it and reports toggles.
  botMeta: BotMetaMap;
  onTogglePin: (botId: string) => void;
  onToggleHide: (botId: string) => void;
  onCopyConversationId: (botId: string) => void;
  // Team B (platform wave): one computer per bot.
  onOpenComputers: () => void;
  // Team D (fleet): multi-user fleet layer.
  onOpenFleet: () => void;
  onOpenGroupChat: () => void;
  // v0.96 (Team T4): Channels — shared workspaces for several bots.
  onOpenChannels: () => void;
  onOpenSkills: () => void;
  // v0.95d4 (Team D4): MemoryView — long-term memory management.
  onOpenMemory: () => void;
  // v0.86c: CanvasView — view a bot's canvases.
  onOpenCanvas: () => void;
  onOpenAutomations: () => void;
  onOpenHarness2: () => void;
  onOpenTools: () => void;
  // v0.95 (Team D1): Internet data — feeds + watched pages.
  onOpenInternetData: () => void;
  // v0.90a (Team G): harness event log.
  onOpenEventLog: () => void;
  // v0.97 (Team T3): AG-UI live activity feed.
  onOpenAgUi: () => void;
  onOpenConnectedApps: () => void;
  // v0.59 (UI-5): threads of the selected bot. `threadSearchResults`
  // is null when no search is active (show the full thread list);
  // a non-null array (possibly empty) replaces the list while searching.
  threads: ThreadView[];
  selectedThreadId: string | null;
  threadSearchResults: ThreadSearchHitView[] | null;
  onSelectThread: (threadId: string) => void;
  onCreateThread: () => void;
  onRenameThread: (threadId: string, title: string) => void;
  onDeleteThread: (threadId: string) => void;
  onSearchThreads: (query: string) => void;
  // v0.60 (UI-9 + UI-11): bots with a chat turn in flight, and pending
  // decision cards per bot (approval / permission / interrupt) — the
  // sidebar running dot and approval badge. App owns both; the sidebar
  // only renders them.
  runningBotIds: ReadonlySet<string>;
  pendingCounts: Record<string, number>;
  // v0.79c (UI parity §7, responsive): collapsed sidebar — icon rail
  // (avatars only). App owns the state (initially collapsed on narrow
  // windows, < 760px); the toggle button lives at the top of the
  // sidebar so it stays reachable while collapsed.
  collapsed: boolean;
  onToggleCollapse: () => void;
}

export default function Sidebar({ bots, selectedBotId, onSelect, onCreate, onEdit, onDelete, onClone, botMeta = {}, onTogglePin, onToggleHide, onCopyConversationId, onOpenDashboard, onOpenPlanner, onOpenSettings, onOpenMarketplace, onOpenMcpMarketplace, onOpenMcpApps, onOpenMcpTasks, onOpenA2a, onOpenTeam, onOpenComputers, onOpenFleet, onOpenGroupChat, onOpenChannels, onOpenSkills, onOpenMemory, onOpenCanvas, onOpenAutomations, onOpenTools, onOpenInternetData, onOpenEventLog, onOpenAgUi, onOpenHarness2, onOpenConnectedApps, threads, selectedThreadId, threadSearchResults, onSelectThread, onCreateThread, onRenameThread, onDeleteThread, onSearchThreads, runningBotIds, pendingCounts, collapsed, onToggleCollapse }: Props) {
  const t = useT();
  // v0.59 (UI-5): thread search box + inline rename + delete confirm
  // (in-app modal, never window.confirm).
  const [query, setQuery] = useState('');
  // v0.60 (UI-11): bot search — filters the bot list by name/provider
  // (diacritic-insensitive, see components/botList.ts).
  const [botQuery, setBotQuery] = useState('');
  // v0.96 (T6): pinned bots sort to the top; hidden bots leave the
  // list until the user shows them again (see botManager.ts).
  const visibleBots = sortBots(filterBots(bots, botQuery), botMeta);
  const hidden = getHiddenBots(bots, botMeta);
  const [showHidden, setShowHidden] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ThreadView | null>(null);
  // v0.62 (UI-13): the bottom nav collapses into one menu — the
  // bot/thread lists keep their height instead of being pushed up by
  // a wall of buttons. Esc closes the menu (and the thread-delete
  // modal below); picking a destination closes it too.
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => {
    if (!navOpen && !deleteTarget) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setNavOpen(false);
        setDeleteTarget(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen, deleteTarget]);
  const navItems = [
    { key: 'dashboard', label: `📊 ${t('sidebar.dashboard')}`, onOpen: onOpenDashboard },
    { key: 'plans', label: `🗺️ ${t('sidebar.plans')}`, onOpen: onOpenPlanner },
    { key: 'marketplace', label: `🛍️ ${t('sidebar.marketplace')}`, onOpen: onOpenMarketplace },
    { key: 'mcp', label: `🔌 ${t('sidebar.mcpMarketplace')}`, onOpen: onOpenMcpMarketplace },
    { key: 'mcp-apps', label: `🖼️ ${t('sidebar.mcpApps')}`, onOpen: onOpenMcpApps },
    { key: 'mcp-tasks', label: `⏳ ${t('sidebar.mcpTasks')}`, onOpen: onOpenMcpTasks },
    { key: 'a2a', label: `🔗 ${t('sidebar.a2aAgents')}`, onOpen: onOpenA2a },
    { key: 'team', label: `👥 ${t('sidebar.team')}`, onOpen: onOpenTeam },
    { key: 'computers', label: `🖥️ ${t('sidebar.computers')}`, onOpen: onOpenComputers },
    { key: 'fleet', label: `🚢 ${t('sidebar.fleet')}`, onOpen: onOpenFleet },
    { key: 'group', label: `💬 ${t('sidebar.groupChat')}`, onOpen: onOpenGroupChat },
    { key: 'channels', label: `📡 ${t('sidebar.channels')}`, onOpen: onOpenChannels },
    { key: 'skills', label: `🧠 ${t('sidebar.skills')}`, onOpen: onOpenSkills },
    { key: 'memory', label: `💭 ${t('sidebar.memory')}`, onOpen: onOpenMemory },
    { key: 'canvas', label: `🎨 ${t('sidebar.canvas')}`, onOpen: onOpenCanvas },
    { key: 'tools', label: t('sidebar.tools'), onOpen: onOpenTools },
    { key: 'internet-data', label: `🌐 ${t('sidebar.internetData')}`, onOpen: onOpenInternetData },
    { key: 'eventlog', label: `📜 ${t('sidebar.eventLog')}`, onOpen: onOpenEventLog },
    { key: 'agui', label: `⚡ ${t('sidebar.activityFeed')}`, onOpen: onOpenAgUi },
    { key: 'connected-apps', label: `🧩 ${t('sidebar.connectedApps')}`, onOpen: onOpenConnectedApps },
    { key: 'automations', label: `⏰ ${t('sidebar.automations')}`, onOpen: onOpenAutomations },
    { key: 'harness2', label: `🔌 ${t('sidebar.harness2')}`, onOpen: onOpenHarness2 },
    { key: 'settings', label: `⚙️ ${t('sidebar.settings')}`, onOpen: onOpenSettings },
  ];
  const searching = query.trim() !== '';
  const selectedBot = bots.find((b) => b.id === selectedBotId) ?? null;

  const handleSearch = (value: string) => {
    setQuery(value);
    onSearchThreads(value);
  };

  const commitRename = (thread: ThreadView) => {
    // Enter and blur can both fire for one edit — commit at most once.
    if (renamingId !== thread.id) return;
    const title = renameValue.trim();
    setRenamingId(null);
    if (title && title !== thread.title) onRenameThread(thread.id, title);
  };

  const threadDate = (thread: ThreadView) => {
    try {
      return new Date(thread.createdAt).toLocaleDateString();
    } catch {
      return '';
    }
  };
  return (
    <aside className={collapsed ? 'sidebar collapsed' : 'sidebar'} data-testid="sidebar">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ flex: 1, minWidth: 0 }}>🤖 Open Bot</h1>
        <button
          className="btn secondary"
          style={{ padding: '4px 10px', flexShrink: 0 }}
          data-testid="sidebar-collapse-toggle"
          title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          aria-label={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          aria-expanded={!collapsed}
          onClick={onToggleCollapse}
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>
      <button className="btn" onClick={onCreate}>{collapsed ? '+' : `+ ${t('sidebar.createBot')}`}</button>
      <h2>{t('sidebar.yourBots')}</h2>
      <input
        type="search"
        value={botQuery}
        onChange={(e) => setBotQuery(e.target.value)}
        placeholder={t('sidebar.searchBotsPlaceholder')}
        aria-label={t('sidebar.searchBotsPlaceholder')}
        data-testid="bot-search"
      />
      {bots.length === 0 && <p className="empty">{t('sidebar.noBots')}</p>}
      {bots.length > 0 && visibleBots.length === 0 && (
        <p className="empty">{t('sidebar.noBotResults')}</p>
      )}
      {visibleBots.map((bot) => (
        <div key={bot.id} className={`bot-item ${bot.id === selectedBotId ? 'active' : ''}`} data-testid="bot-row" data-bot-id={bot.id}>
          {/* v0.60 (UI-11): running/idle dot — a bot with a turn in
              flight shows green, everything else idle grey. */}
          <span
            className={`bot-status ${runningBotIds.has(bot.id) ? 'running' : 'idle'}`}
            title={runningBotIds.has(bot.id) ? t('sidebar.botRunning') : t('sidebar.botIdle')}
            aria-label={runningBotIds.has(bot.id) ? t('sidebar.botRunning') : t('sidebar.botIdle')}
          >
            ●
          </span>
          {/* v0.62 (UI-13): avatar — coloured circle with the bot's
              initial, so bots are recognisable at a glance. v0.79c: in
              the collapsed rail the name button is hidden by CSS, so
              the avatar itself becomes the select button. */}
          {collapsed ? (
            <button
              className="bot-avatar"
              style={{ background: botColor(bot.color), border: 'none', cursor: 'pointer' }}
              data-testid="bot-avatar"
              data-bot-id={bot.id}
              title={bot.name}
              aria-label={bot.name}
              onClick={() => onSelect(bot.id)}
            >
              {botInitial(bot.name)}
            </button>
          ) : (
            <span
              className="bot-avatar"
              style={{ background: botColor(bot.color) }}
              data-testid="bot-avatar"
              aria-hidden="true"
            >
              {botInitial(bot.name)}
            </span>
          )}
          <button className="bot-item" style={{ border: 'none', padding: 0 }} onClick={() => onSelect(bot.id)} title={bot.description?.trim() ? `${bot.name} — ${bot.description.trim()}` : bot.name}>
            <span className="name">
              {bot.name}
              <span className="meta">{bot.providerId} · {bot.model || t('sidebar.defaultModel')}</span>
              {/* v0.77 (UI parity §3.3): short description under the name. */}
              {bot.description?.trim() && (
                <span className="desc" data-testid="bot-description">{bot.description.trim()}</span>
              )}
            </span>
          </button>
          {/* v0.60 (UI-9): pending decision cards for this bot — the
              count mirrors the approval tray; 0 shows no badge. */}
          {(pendingCounts[bot.id] ?? 0) > 0 && (
            <span
              className="badge approval"
              data-testid="bot-approval-badge"
              title={t('sidebar.pendingApprovals', { count: String(pendingCounts[bot.id] ?? 0) })}
            >
              {pendingCounts[bot.id] ?? 0}
            </span>
          )}
          {/* v0.96 (T6): unread dot — the bot streamed while another
              bot was selected (cleared when the bot is opened). */}
          {botMeta[bot.id]?.unread === true && (
            <span
              className="badge"
              data-testid="bot-unread-dot"
              title={t('botMgmt.unread')}
              aria-label={t('botMgmt.unread')}
              style={{ background: '#2563eb', minWidth: 8, width: 8, height: 8, padding: 0, borderRadius: '50%' }}
            />
          )}
          {/* v0.96 (T6): pinned bots sort to the top (pin icon filled). */}
          {botMeta[bot.id]?.pinned === true && (
            <span title={t('botMgmt.pinned')} aria-label={t('botMgmt.pinned')}>📌</span>
          )}
          <button className="icon-btn" title={botMeta[bot.id]?.pinned ? t('botMgmt.unpin') : t('botMgmt.pin')} aria-label={botMeta[bot.id]?.pinned ? t('botMgmt.unpin') : t('botMgmt.pin')} onClick={() => onTogglePin(bot.id)}>📌</button>
          <button className="icon-btn" title={t('botMgmt.hide')} aria-label={t('botMgmt.hide')} onClick={() => onToggleHide(bot.id)}>🙈</button>
          <button className="icon-btn" title={t('botMgmt.copyId')} aria-label={t('botMgmt.copyId')} onClick={() => onCopyConversationId(bot.id)}>🔗</button>
          <button className="icon-btn" title={t('sidebar.editBot')} onClick={() => onEdit(bot)}>✏️</button>
          <button className="icon-btn" title={t('sidebar.cloneBot')} onClick={() => onClone(bot)}>📋</button>
          <button className="icon-btn" title={t('sidebar.deleteBot')} onClick={() => onDelete(bot)}>🗑️</button>
        </div>
      ))}
      {hidden.length > 0 && (
        <button
          className="btn secondary"
          style={{ marginTop: 4 }}
          data-testid="sidebar-show-hidden"
          onClick={() => setShowHidden((v) => !v)}
        >
          {showHidden
            ? t('botMgmt.hideHidden')
            : t('botMgmt.showHidden', { count: String(hidden.length) })}
        </button>
      )}
      {showHidden && hidden.map((bot) => (
        <div key={bot.id} className="bot-item" data-testid="bot-row-hidden" data-bot-id={bot.id}>
          <span className="name" style={{ opacity: 0.6 }}>{bot.name}</span>
          <button className="icon-btn" title={t('botMgmt.unhide')} aria-label={t('botMgmt.unhide')} onClick={() => onToggleHide(bot.id)}>👁️</button>
        </div>
      ))}
      {selectedBot && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 4 }}>
            <h2 style={{ margin: 0 }}>{t('thread.title')}</h2>
            <button className="btn secondary" style={{ padding: '4px 10px' }} onClick={onCreateThread} title={t('thread.new')} data-testid="thread-new">
              + {t('thread.new')}
            </button>
          </div>
          <input
            type="search"
            value={query}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder={t('thread.searchPlaceholder')}
            aria-label={t('thread.searchPlaceholder')}
            data-testid="thread-search"
          />
          {searching ? (
            <>
              {threadSearchResults !== null && threadSearchResults.length === 0 && (
                <p className="empty" style={{ padding: '12px 0' }}>{t('thread.noResults')}</p>
              )}
              {(threadSearchResults ?? []).map((hit) => (
                <div key={hit.thread.id} className={`bot-item ${hit.thread.id === selectedThreadId ? 'active' : ''}`} data-testid="thread-row">
                  <button
                    className="bot-item"
                    style={{ border: 'none', padding: 0 }}
                    onClick={() => {
                      onSelectThread(hit.thread.id);
                      setQuery('');
                      onSearchThreads('');
                    }}
                    title={hit.thread.title}
                  >
                    <span className="name">
                      {hit.thread.title}
                      <span className="meta">{hit.snippet}</span>
                    </span>
                  </button>
                </div>
              ))}
            </>
          ) : (
            <>
              {threads.length === 0 && <p className="empty" style={{ padding: '12px 0' }}>{t('thread.noThreads')}</p>}
              {threads.map((thread) => (
                <div key={thread.id} className={`bot-item ${thread.id === selectedThreadId ? 'active' : ''}`} data-testid="thread-row">
                  {renamingId === thread.id ? (
                    <input
                      autoFocus
                      value={renameValue}
                      data-testid="thread-rename-input"
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(thread);
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                      onBlur={() => commitRename(thread)}
                      placeholder={t('thread.renamePlaceholder')}
                      aria-label={t('thread.renamePlaceholder')}
                    />
                  ) : (
                    <button className="bot-item" style={{ border: 'none', padding: 0 }} onClick={() => onSelectThread(thread.id)} title={thread.title}>
                      <span className="name">
                        {thread.title}
                        <span className="meta">
                          {thread.messageCount} · {threadDate(thread)}
                        </span>
                      </span>
                    </button>
                  )}
                  <button
                    className="icon-btn"
                    title={t('thread.rename')}
                    onClick={() => {
                      setRenamingId(thread.id);
                      setRenameValue(thread.title);
                    }}
                  >
                    ✏️
                  </button>
                  <button className="icon-btn" title={t('thread.delete')} onClick={() => setDeleteTarget(thread)}>🗑️</button>
                </div>
              ))}
            </>
          )}
        </>
      )}
      <div style={{ flex: 1 }} />
      <div className="sidebar-nav">
        <button
          className="btn secondary"
          style={{ width: '100%' }}
          data-testid="sidebar-nav-menu"
          aria-expanded={navOpen}
          aria-haspopup="menu"
          onClick={() => setNavOpen((v) => !v)}
          title={navOpen ? t('sidebar.navMenuClose') : t('sidebar.navMenu')}
        >
          {collapsed ? '⋯' : t('sidebar.navMenu')}
        </button>
        {navOpen && (
          <>
            {/* Click-outside closes the menu (Esc and picking a
                destination already did); the overlay sits under the
                dropdown (z-index 4 vs 5) so menu rows stay clickable. */}
            <div className="sidebar-nav-overlay" onClick={() => setNavOpen(false)} />
            <div className="sidebar-nav-dropdown" role="menu" data-testid="sidebar-nav-dropdown">
            {navItems.map((item) => (
              <button
                key={item.key}
                type="button"
                className="btn secondary"
                data-nav-key={item.key}
                onClick={() => {
                  setNavOpen(false);
                  item.onOpen();
                }}
              >
                {item.label}
              </button>
            ))}
            </div>
          </>
        )}
      </div>
      <p className="sidebar-note" style={{ fontSize: 12, color: 'var(--text-dim)', margin: '4px 0 0' }}>
        {t('sidebar.localFirstNote')}
      </p>
      {deleteTarget && (
        <div className="modal-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{t('thread.deleteTitle')}</h2>
            <p>{t('thread.deleteConfirm', { title: deleteTarget.title })}</p>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="btn secondary" onClick={() => setDeleteTarget(null)}>
                {t('botForm.cancel')}
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  onDeleteThread(deleteTarget.id);
                  setDeleteTarget(null);
                }}
              >
                {t('thread.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
