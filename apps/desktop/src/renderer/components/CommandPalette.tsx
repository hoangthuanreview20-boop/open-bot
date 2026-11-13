/**
 * Command palette v2 (UI-13, v0.62; v2 in v0.96, Team T6) — Cmd/Ctrl+K quick find.
 *
 * One input + grouped results, in this order:
 * - recent commands (last picks, kept in localStorage, max 8) — only
 *   when the query is empty, so the palette opens on what the user
 *   actually does;
 * - bots (diacritic-insensitive name/provider/model match, like the
 *   sidebar search) — picking one opens its chat;
 * - actions — create a bot, open the tool browser, switch the model
 *   of the current bot, open settings, run an automation, open group
 *   chat — the verbs, not just the nouns;
 * - slash commands of the selected bot (same `slash:list` registry the
 *   composer popup uses) — picking one inserts `/name ` into the
 *   composer (App owns the insert; ChatView applies it);
 * - screens — the chat + the sidebar destinations, same labels as
 *   the nav menu.
 *
 * Ranking is a hand-written fuzzy match (see fuzzySearch.ts): a
 * subsequence match scored for word starts and consecutive runs,
 * diacritic-insensitive, so "td" finds "Tao bot" and "mcp" finds the
 * MCP marketplace. With an empty query the groups keep their stable
 * order; with a query every group is ranked best-first.
 *
 * Keyboard: ↑/↓ moves, Enter runs the active row, Esc closes (App also
 * closes it on a window-level Esc). Mouse: hover moves, click runs.
 * Presentational except for the slash list + automation list, which
 * it loads itself for the selected bot (missing IPC = no rows, like
 * ChatView).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BotConfigLike } from '../types';
import { useT } from '../i18n/useT';
import { filterBots } from './botList';
import { normalizeSearchText } from './settings/settingsTabs';
import { fuzzyFilter, fuzzyScore } from './fuzzySearch';
import { readPaletteRecent, recordPaletteRecent } from './paletteRecent';

export type PaletteViewId =
  | 'chat'
  | 'dashboard'
  | 'planner'
  | 'settings'
  | 'marketplace'
  | 'mcp'
  | 'team'
  | 'computers'
  | 'fleet'
  | 'skills'
  | 'automations'
  | 'tools'
  | 'eventlog'
  | 'connected-apps'
  | 'a2a'
  | 'canvas'
  | 'group'
  | 'memory'
  | 'internet-data';

export { PALETTE_RECENT_KEY } from './paletteRecent';

function safeLocalStorage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

interface PaletteItem {
  key: string;
  group: 'recent' | 'bots' | 'actions' | 'commands' | 'views';
  label: string;
  description: string;
  /** Text the fuzzy matcher scores against (label + description). */
  searchText: string;
  run: () => void;
}

interface Props {
  bots: BotConfigLike[];
  selectedBotId: string | null;
  onSelectBot: (botId: string) => void;
  onOpenView: (view: PaletteViewId) => void;
  onInsertSlash: (text: string) => void;
  onCreateBot: () => void;
  onOpenModelPicker: () => void;
  onRunAutomation: (automationId: string) => void;
  onClose: () => void;
}

export default function CommandPalette({
  bots,
  selectedBotId,
  onSelectBot,
  onOpenView,
  onInsertSlash,
  onCreateBot,
  onOpenModelPicker,
  onRunAutomation,
  onClose,
}: Props) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  // v0.98 (T6): hover only selects a row when the mouse REALLY moves.
  // Root cause: the cursor sits still over the list; while filtering
  // (query changes) the row under it changes, so mouseenter fires and
  // steals activeIndex from the first row (ui-13 test: typing a
  // sample bot name then Enter opened Settings instead of the bot chat).
  // Typing resets active to 0 and locks hover; a real mousemove on the
  // list unlocks it again.
  const [slashCommands, setSlashCommands] = useState<Array<{ name: string; description: string }>>([]);
  const [automations, setAutomations] = useState<Array<{ id: string; name: string }>>([]);
  const [recentKeys, setRecentKeys] = useState<string[]>(() => readPaletteRecent(safeLocalStorage()));
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!selectedBotId) {
      setSlashCommands([]);
      return;
    }
    let alive = true;
    const api = window.openBot as unknown as {
      listSlashCommands?: (botId: string) => Promise<Array<{ name: string; description: string }>>;
    };
    if (typeof api.listSlashCommands !== 'function') {
      setSlashCommands([]);
      return;
    }
    void api
      .listSlashCommands(selectedBotId)
      .then((list) => {
        if (alive) setSlashCommands(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (alive) setSlashCommands([]);
      });
    return () => {
      alive = false;
    };
  }, [selectedBotId]);

  // v0.96 (palette v2): automations for the "run automation" action —
  // missing IPC = no rows, same defensive pattern as slash commands.
  useEffect(() => {
    let alive = true;
    const api = window.openBot as unknown as {
      listAutomations?: () => Promise<unknown[]>;
    };
    if (typeof api.listAutomations !== 'function') {
      setAutomations([]);
      return;
    }
    void api
      .listAutomations()
      .then((list) => {
        if (!alive) return;
        const rows = (Array.isArray(list) ? list : [])
          .map((a) => a as { id?: unknown; name?: unknown })
          .filter((a) => typeof a.id === 'string' && typeof a.name === 'string')
          .map((a) => ({ id: a.id as string, name: a.name as string }));
        setAutomations(rows);
      })
      .catch(() => {
        if (alive) setAutomations([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const views: Array<{ id: PaletteViewId; label: string }> = [
    { id: 'chat', label: t('palette.chatView') },
    { id: 'dashboard', label: `📊 ${t('sidebar.dashboard')}` },
    { id: 'planner', label: `🗺️ ${t('sidebar.plans')}` },
    { id: 'marketplace', label: `🛍️ ${t('sidebar.marketplace')}` },
    { id: 'mcp', label: `🔌 ${t('sidebar.mcpMarketplace')}` },
    { id: 'a2a', label: `🔗 ${t('sidebar.a2aAgents')}` },
    { id: 'team', label: `👥 ${t('sidebar.team')}` },
    { id: 'computers', label: `🖥️ ${t('sidebar.computers')}` },
    { id: 'fleet', label: `🚢 ${t('sidebar.fleet')}` },
    { id: 'group', label: `💬 ${t('sidebar.groupChat')}` },
    { id: 'skills', label: `🧠 ${t('sidebar.skills')}` },
    { id: 'memory', label: `💭 ${t('sidebar.memory')}` },
    { id: 'canvas', label: `🎨 ${t('sidebar.canvas')}` },
    { id: 'tools', label: t('sidebar.tools') },
    { id: 'internet-data', label: `🌐 ${t('sidebar.internetData')}` },
    { id: 'eventlog', label: `📜 ${t('sidebar.eventLog')}` },
    { id: 'connected-apps', label: `🧩 ${t('sidebar.connectedApps')}` },
    { id: 'automations', label: `⏰ ${t('sidebar.automations')}` },
    { id: 'settings', label: `⚙️ ${t('sidebar.settings')}` },
  ];

  const q = normalizeSearchText(query);

  const allItems = useMemo(() => {
    const out: PaletteItem[] = [];
    for (const bot of filterBots(bots, query)) {
      out.push({
        key: `bot:${bot.id}`,
        group: 'bots',
        label: bot.name,
        description: `${bot.providerId} · ${bot.model || ''}`.trim(),
        searchText: `${bot.name} ${bot.providerId} ${bot.model || ''}`,
        run: () => onSelectBot(bot.id),
      });
    }
    // v0.96 (palette v2): actions — the verbs.
    const actions: PaletteItem[] = [
      {
        key: 'action:create-bot',
        group: 'actions',
        label: t('palette.createBot'),
        description: t('palette.createBotDesc'),
        searchText: `${t('palette.createBot')} ${t('palette.createBotDesc')}`,
        run: onCreateBot,
      },
      {
        key: 'action:open-tools',
        group: 'actions',
        label: t('palette.openTools'),
        description: t('palette.openToolsDesc'),
        searchText: `${t('palette.openTools')} ${t('palette.openToolsDesc')}`,
        run: () => onOpenView('tools'),
      },
      {
        key: 'action:switch-model',
        group: 'actions',
        label: t('palette.switchModel'),
        description: t('palette.switchModelDesc'),
        searchText: `${t('palette.switchModel')} ${t('palette.switchModelDesc')}`,
        run: onOpenModelPicker,
      },
      {
        key: 'action:open-settings',
        group: 'actions',
        label: t('palette.openSettings'),
        description: t('palette.openSettingsDesc'),
        searchText: `${t('palette.openSettings')} ${t('palette.openSettingsDesc')}`,
        run: () => onOpenView('settings'),
      },
      {
        key: 'action:open-group',
        group: 'actions',
        label: t('palette.openGroup'),
        description: t('palette.openGroupDesc'),
        searchText: `${t('palette.openGroup')} ${t('palette.openGroupDesc')}`,
        run: () => onOpenView('group'),
      },
    ];
    for (const automation of automations) {
      actions.push({
        key: `action:run-automation:${automation.id}`,
        group: 'actions',
        label: t('palette.runAutomation', { name: automation.name }),
        description: t('palette.runAutomationDesc'),
        searchText: `${automation.name} ${t('palette.runAutomationDesc')}`,
        run: () => onRunAutomation(automation.id),
      });
    }
    for (const action of actions) {
      if (q && fuzzyScore(q, action.searchText) === null) continue;
      out.push(action);
    }
    for (const cmd of slashCommands) {
      if (q && !normalizeSearchText(`/${cmd.name} ${cmd.description}`).includes(q)) continue;
      out.push({
        key: `cmd:/${cmd.name}`,
        group: 'commands',
        label: `/${cmd.name}`,
        description: cmd.description,
        searchText: `/${cmd.name} ${cmd.description}`,
        run: () => onInsertSlash(`/${cmd.name} `),
      });
    }
    for (const view of views) {
      if (q && !normalizeSearchText(view.label).includes(q)) continue;
      out.push({
        key: `view:${view.id}`,
        group: 'views',
        label: view.label,
        description: '',
        searchText: view.label,
        run: () => onOpenView(view.id),
      });
    }
    return out;
    // `views` is rebuilt every render from `t` — listing it would
    // re-run this memo every render anyway; the inputs that matter
    // (bots, query, slashCommands, automations) are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bots, query, slashCommands, automations, q]);

  // Rank within each group when there is a query; keep the stable
  // group order with an empty query. Recents only show with an empty
  // query (they are the user's habits, not search results).
  const items = useMemo(() => {
    const byKey = new Map(allItems.map((item) => [item.key, item]));
    if (!q) {
      const recents: PaletteItem[] = [];
      for (const key of recentKeys) {
        const item = byKey.get(key);
        if (item) recents.push({ ...item, group: 'recent' });
      }
      return [...recents, ...allItems];
    }
    const groupOrder: Array<PaletteItem['group']> = ['bots', 'actions', 'commands', 'views'];
    const ranked: PaletteItem[] = [];
    for (const group of groupOrder) {
      const rows = allItems.filter((item) => item.group === group);
      ranked.push(...fuzzyFilter(rows, query, (item) => item.searchText).map((r) => r.item));
    }
    return ranked;
  }, [allItems, recentKeys, q, query]);

  // The list shrinks as the user types — keep the active row in range.
  const active = items.length === 0 ? 0 : Math.min(activeIndex, items.length - 1);

  // v0.97 (merge-verify): hover must follow the MOUSE, not the layout.
  // When the list shrinks after typing, rows slide under a stationary
  // cursor and Chromium fires mouseenter on the row now under it; that
  // used to hijack the keyboard-active row, so Enter ran the hovered
  // action instead of the first match (ui-13-smoke: typing the sample
  // bot name left the Settings action active instead of the bot row).
  // Ignore mouseenter until the pointer actually moves after the list
  // changes — a real mouse move always fires mousemove on the list
  // before the next mouseenter, so genuine hover still works.
  const pointerMovedRef = useRef(false);
  const itemsKey = items.map((item) => item.key).join('|');
  useEffect(() => {
    pointerMovedRef.current = false;
  }, [itemsKey]);

  const runItem = (item: PaletteItem) => {
    setRecentKeys(recordPaletteRecent(safeLocalStorage(), item.key));
    item.run();
  };

  const groups: Array<{ id: PaletteItem['group']; title: string }> = [
    { id: 'recent', title: t('palette.recent') },
    { id: 'bots', title: t('palette.bots') },
    { id: 'actions', title: t('palette.actions') },
    { id: 'commands', title: t('palette.commands') },
    { id: 'views', title: t('palette.views') },
  ];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-label={t('palette.title')}
        data-testid="command-palette"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="search"
          value={query}
          data-testid="command-palette-input"
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
              return;
            }
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              if (items.length === 0) return;
              const dir = e.key === 'ArrowDown' ? 1 : -1;
              setActiveIndex((prev) => (prev + dir + items.length) % items.length);
              return;
            }
            if (e.key === 'Enter' && items.length > 0) {
              e.preventDefault();
              const item = items[active];
              if (item) runItem(item);
            }
          }}
          placeholder={t('palette.placeholder')}
          aria-label={t('palette.placeholder')}
        />
        <div className="palette-list" onMouseMove={() => { pointerMovedRef.current = true; }}>
          {items.length === 0 && <div className="palette-empty">{t('palette.empty')}</div>}
          {groups.map((group) => {
            const rows = items
              .map((item, index) => ({ item, index }))
              .filter(({ item }) => item.group === group.id);
            if (rows.length === 0) return null;
            return (
              <div key={group.id}>
                <div className="palette-group">{group.title}</div>
                {rows.map(({ item, index }) => (
                  <button
                    key={item.key}
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    className={`palette-item${index === active ? ' active' : ''}`}
                    onMouseEnter={() => { if (pointerMovedRef.current) setActiveIndex(index); }}
                    onClick={() => runItem(item)}
                  >
                    <span className="palette-item-label">{item.label}</span>
                    {item.description ? (
                      <span className="palette-item-desc">{item.description}</span>
                    ) : null}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
        <p className="palette-empty" style={{ paddingBottom: 0 }}>{t('palette.hint')}</p>
      </div>
    </div>
  );
}
