/**
 * Command palette (UI-13, v0.62) — Cmd/Ctrl+K quick find.
 *
 * One input + grouped results, in this order:
 * - bots (diacritic-insensitive name/provider/model match, like the
 *   sidebar search) — picking one opens its chat;
 * - slash commands of the selected bot (same `slash:list` registry the
 *   composer popup uses) — picking one inserts `/name ` into the
 *   composer (App owns the insert; ChatView applies it);
 * - screens — the chat + the 10 sidebar destinations, same labels as
 *   the nav menu.
 *
 * Keyboard: ↑/↓ moves, Enter runs the active row, Esc closes (App also
 * closes it on a window-level Esc). Mouse: hover moves, click runs.
 * Presentational except for the slash list, which it loads itself for
 * the selected bot (missing `listSlashCommands` = no commands, like
 * ChatView).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BotConfigLike } from '../types';
import { useT } from '../i18n/useT';
import { filterBots } from './botList';
import { normalizeSearchText } from './settings/settingsTabs';

export type PaletteViewId =
  | 'chat'
  | 'settings'
  | 'marketplace'
  | 'mcp'
  | 'team'
  | 'computers'
  | 'skills'
  | 'automations'
  | 'tools'
  | 'eventlog'
  | 'connected-apps'
  | 'a2a'
  | 'canvas'
  | 'group';

interface PaletteItem {
  key: string;
  group: 'bots' | 'commands' | 'views';
  label: string;
  description: string;
  run: () => void;
}

interface Props {
  bots: BotConfigLike[];
  selectedBotId: string | null;
  onSelectBot: (botId: string) => void;
  onOpenView: (view: PaletteViewId) => void;
  onInsertSlash: (text: string) => void;
  onClose: () => void;
}

export default function CommandPalette({ bots, selectedBotId, onSelectBot, onOpenView, onInsertSlash, onClose }: Props) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [slashCommands, setSlashCommands] = useState<Array<{ name: string; description: string }>>([]);
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

  const views: Array<{ id: PaletteViewId; label: string }> = [
    { id: 'chat', label: t('palette.chatView') },
    { id: 'marketplace', label: `🛍️ ${t('sidebar.marketplace')}` },
    { id: 'mcp', label: `🔌 ${t('sidebar.mcpMarketplace')}` },
    { id: 'a2a', label: `🔗 ${t('sidebar.a2aAgents')}` },
    { id: 'team', label: `👥 ${t('sidebar.team')}` },
    { id: 'computers', label: `🖥️ ${t('sidebar.computers')}` },
    { id: 'group', label: `💬 ${t('sidebar.groupChat')}` },
    { id: 'skills', label: `🧠 ${t('sidebar.skills')}` },
    { id: 'canvas', label: `🎨 ${t('sidebar.canvas')}` },
    { id: 'tools', label: t('sidebar.tools') },
    { id: 'eventlog', label: `📜 ${t('sidebar.eventLog')}` },
    { id: 'connected-apps', label: `🧩 ${t('sidebar.connectedApps')}` },
    { id: 'automations', label: `⏰ ${t('sidebar.automations')}` },
    { id: 'settings', label: `⚙️ ${t('sidebar.settings')}` },
  ];

  const q = normalizeSearchText(query);
  const items = useMemo(() => {
    const out: PaletteItem[] = [];
    for (const bot of filterBots(bots, query)) {
      out.push({
        key: `bot:${bot.id}`,
        group: 'bots',
        label: bot.name,
        description: `${bot.providerId} · ${bot.model || ''}`.trim(),
        run: () => onSelectBot(bot.id),
      });
    }
    for (const cmd of slashCommands) {
      if (q && !normalizeSearchText(`/${cmd.name} ${cmd.description}`).includes(q)) continue;
      out.push({
        key: `cmd:/${cmd.name}`,
        group: 'commands',
        label: `/${cmd.name}`,
        description: cmd.description,
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
        run: () => onOpenView(view.id),
      });
    }
    return out;
    // `views` is rebuilt every render from `t` — listing it would
    // re-run this memo every render anyway; the inputs that matter
    // (bots, query, slashCommands) are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bots, query, slashCommands, q]);

  // The list shrinks as the user types — keep the active row in range.
  const active = items.length === 0 ? 0 : Math.min(activeIndex, items.length - 1);

  const groups: Array<{ id: PaletteItem['group']; title: string }> = [
    { id: 'bots', title: t('palette.bots') },
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
              items[active]?.run();
            }
          }}
          placeholder={t('palette.placeholder')}
          aria-label={t('palette.placeholder')}
        />
        <div className="palette-list">
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
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => item.run()}
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
