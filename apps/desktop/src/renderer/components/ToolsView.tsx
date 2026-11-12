/**
 * v0.59 (UI-3): a dedicated "Tools" screen per bot — answers "what
 * tools does this bot have, which are on, which cost many tokens".
 *
 * Tools used to leak only in scattered places (tool-call cards in
 * chat show only tools already called, the MCP marketplace lists
 * servers only, Connected apps are buried inside Settings). This
 * screen reuses the registry/filter/cap data already available via
 * IPC `tools:list` (coordinator RPC `listBotTools`) and toggles via
 * IPC `tools:toggle` (the policy's denyTools — no parallel mechanism).
 *
 * Search + group filtering follow the same rules as `filterToolList`
 * (packages/core/src/agent/toolFilter.ts — the renderer is
 * self-contained so it does not import core; the logic is mirrored
 * compactly here, see `matchesQuery`).
 */
import { useEffect, useMemo, useState } from 'react';
import type {
  BotSkillInfoView,
  BotToolInfoView,
  ListBotSkillsResultView,
  ListBotToolsResultView,
} from '../types';
import { useT } from '../i18n/useT';

/** Essential communication tools — disabling one leaves the agent unable to ask the user back (see ESSENTIAL_TOOLS in toolFilter.ts). */
const ESSENTIAL_TOOLS = new Set([
  'ask_user',
  'send_message_to_user',
  'send_progress_update',
  'send_final_summary',
]);

function matchesQuery(tool: BotToolInfoView, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = `${tool.name} ${tool.description} ${tool.group}`.toLowerCase();
  return words.every((w) => haystack.includes(w));
}

interface Props {
  botId: string | null;
  botName?: string | null;
  onBack: () => void;
}

export default function ToolsView({ botId, botName, onBack }: Props) {
  const t = useT();
  const [data, setData] = useState<ListBotToolsResultView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<string>('all');
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [busyTool, setBusyTool] = useState<string | null>(null);
  // v0.64 (skills per-bot): per-bot skill list, loaded next to the
  // tools (same screen, separate IPC so a skills failure never hides
  // the tools list, and vice versa).
  const [skillsData, setSkillsData] = useState<ListBotSkillsResultView | null>(null);
  const [skillsError, setSkillsError] = useState('');
  const [busySkill, setBusySkill] = useState<string | null>(null);

  const load = async (id: string) => {
    setLoading(true);
    setError('');
    setSkillsError('');
    try {
      setData(await window.openBot.listBotTools(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('tools.loadError'));
    } finally {
      setLoading(false);
    }
    try {
      setSkillsData(await window.openBot.listBotSkills(id));
    } catch (e) {
      setSkillsData(null);
      setSkillsError(e instanceof Error ? e.message : t('tools.skillsLoadError'));
    }
  };

  useEffect(() => {
    if (!botId) {
      setData(null);
      setSkillsData(null);
      setSkillsError('');
      setLoading(false);
      return;
    }
    setGroup('all');
    setQuery('');
    setEnabledOnly(false);
    void load(botId);
    // Reload whenever the selected bot changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId]);

  /** Groups present in the list (first-appearance order) + tool count per group. */
  const groups = useMemo(() => {
    const out: Array<{ name: string; count: number }> = [];
    const byName = new Map<string, { name: string; count: number }>();
    for (const tool of data?.tools ?? []) {
      let entry = byName.get(tool.group);
      if (!entry) {
        entry = { name: tool.group, count: 0 };
        byName.set(tool.group, entry);
        out.push(entry);
      }
      entry.count += 1;
    }
    return out;
  }, [data]);

  const filtered = useMemo(() => {
    return (data?.tools ?? []).filter((tool) => {
      if (group !== 'all' && tool.group !== group) return false;
      if (enabledOnly && !tool.enabled) return false;
      return matchesQuery(tool, query);
    });
  }, [data, group, enabledOnly, query]);

  const toggle = async (tool: BotToolInfoView) => {
    if (!botId || busyTool) return;
    setBusyTool(tool.name);
    setError('');
    const nextEnabled = !tool.enabled;
    // Optimistic UI update; on error, roll back from the previous data.
    setData((prev) =>
      prev
        ? {
            ...prev,
            tools: prev.tools.map((x) =>
              x.name === tool.name ? { ...x, enabled: nextEnabled } : x,
            ),
            enabledTools: prev.enabledTools + (nextEnabled ? 1 : -1),
            enabledTokens: prev.enabledTokens + (nextEnabled ? tool.tokenEstimate : -tool.tokenEstimate),
          }
        : prev,
    );
    try {
      await window.openBot.setBotToolEnabled(botId, tool.name, nextEnabled);
    } catch (e) {
      setData((prev) =>
        prev
          ? {
              ...prev,
              tools: prev.tools.map((x) =>
                x.name === tool.name ? { ...x, enabled: tool.enabled } : x,
              ),
              enabledTools: prev.enabledTools + (tool.enabled ? 1 : -1),
              enabledTokens:
                prev.enabledTokens + (tool.enabled ? tool.tokenEstimate : -tool.tokenEstimate),
            }
          : prev,
      );
      setError(e instanceof Error ? e.message : t('tools.toggleError'));
    } finally {
      setBusyTool(null);
    }
  };

  const sourceLabel = (source: BotToolInfoView['source']) =>
    source === 'composio'
      ? t('tools.sourceComposio')
      : source === 'plugin'
        ? t('tools.sourcePlugin')
        : t('tools.sourceCore');

  // v0.64 (skills per-bot): same optimistic toggle as tools — flip
  // the row immediately, roll back from the previous data on error.
  // A globally disabled skill has its checkbox locked (see the row
  // below); this handler never runs for it.
  const toggleSkill = async (skill: BotSkillInfoView) => {
    if (!botId || busySkill) return;
    setBusySkill(skill.name);
    setSkillsError('');
    const nextEnabled = !skill.enabled;
    setSkillsData((prev) =>
      prev
        ? {
            ...prev,
            skills: prev.skills.map((x) =>
              x.name === skill.name ? { ...x, enabled: nextEnabled } : x,
            ),
            enabledSkills: prev.enabledSkills + (nextEnabled ? 1 : -1),
          }
        : prev,
    );
    try {
      await window.openBot.setBotSkillEnabled(botId, skill.name, nextEnabled);
    } catch (e) {
      setSkillsData((prev) =>
        prev
          ? {
              ...prev,
              skills: prev.skills.map((x) =>
                x.name === skill.name ? { ...x, enabled: skill.enabled } : x,
              ),
              enabledSkills: prev.enabledSkills + (skill.enabled ? 1 : -1),
            }
          : prev,
      );
      setSkillsError(e instanceof Error ? e.message : t('tools.skillsToggleError'));
    } finally {
      setBusySkill(null);
    }
  };

  return (
    <div data-testid="tools-view">
      <button className="btn secondary" onClick={onBack}>
        {t('tools.back')}
      </button>
      <h2>
        {botName ? t('tools.title', { bot: botName }) : 'Tools'}
      </h2>
      {!botId && <p className="empty">{t('tools.noBot')}</p>}
      {botId && loading && <p>{t('tools.loading')}</p>}
      {botId && !loading && data && (
        <>
          <p style={{ color: 'var(--text-dim)' }}>
            {t('tools.summary', {
              enabled: data.enabledTools,
              total: data.totalTools,
              enabledTokens: data.enabledTokens,
              totalTokens: data.totalTokens,
            })}
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <input
              data-testid="tools-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('tools.searchPlaceholder')}
              style={{ flex: 1, minWidth: 200 }}
            />
            <select
              data-testid="tools-group-filter"
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              aria-label={t('tools.allGroups')}
            >
              <option value="all">
                {t('tools.allGroups')} ({data.totalTools})
              </option>
              {groups.map((g) => (
                <option key={g.name} value={g.name}>
                  {g.name} ({g.count})
                </option>
              ))}
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input
                type="checkbox"
                checked={enabledOnly}
                onChange={(e) => setEnabledOnly(e.target.checked)}
              />
              {t('tools.enabledOnly')}
            </label>
          </div>
          <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>
            {t('tools.showing', { shown: filtered.length, total: data.totalTools })}
          </p>
          {filtered.length === 0 && <p className="empty">{t('tools.noMatch')}</p>}
          {filtered.map((tool) => {
            const params = Object.entries(tool.parameters.properties);
            return (
              <div
                key={tool.name}
                data-testid={`tool-row-${tool.name}`}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: 12,
                  marginBottom: 8,
                  opacity: tool.enabled ? 1 : 0.6,
                }}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <code style={{ fontWeight: 600 }}>{tool.name}</code>
                  <span className="badge">{tool.group}</span>
                  <span className="badge">{sourceLabel(tool.source)}</span>
                  {tool.readOnly && <span className="badge">{t('tools.readOnly')}</span>}
                  {tool.cappedByApp && <span className="badge">⚠️ {t('tools.capped')}</span>}
                  {tool.needsApproval && <span className="badge">{t('tools.needsApproval')}</span>}
                  <span style={{ marginLeft: 'auto', color: 'var(--text-dim)', fontSize: 13 }}>
                    {t('tools.tokens', { tokens: tool.tokenEstimate })}
                  </span>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <input
                      data-testid={`tool-toggle-${tool.name}`}
                      type="checkbox"
                      checked={tool.enabled}
                      disabled={busyTool === tool.name}
                      onChange={() => void toggle(tool)}
                    />
                    {tool.enabled ? t('tools.enabled') : t('tools.disabled')}
                  </label>
                </div>
                {tool.description && (
                  <p style={{ margin: '6px 0 0', color: 'var(--text-dim)' }}>{tool.description}</p>
                )}
                {ESSENTIAL_TOOLS.has(tool.name) && (
                  <p style={{ margin: '6px 0 0', fontSize: 13 }}>ℹ️ {t('tools.essentialNote')}</p>
                )}
                <details style={{ marginTop: 6 }}>
                  <summary style={{ cursor: 'pointer', fontSize: 13 }}>
                    {t('tools.schema')}
                    {params.length > 0 ? ` (${params.length})` : ''}
                  </summary>
                  {params.length === 0 ? (
                    <p style={{ fontSize: 13, color: 'var(--text-dim)' }}>{t('tools.noParams')}</p>
                  ) : (
                    <ul style={{ fontSize: 13, margin: '4px 0 0', paddingLeft: 18 }}>
                      {params.map(([name, type]) => (
                        <li key={name}>
                          <code>{name}</code>: {type}
                          {tool.parameters.required.includes(name)
                            ? ` (${t('tools.required')})`
                            : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </details>
              </div>
            );
          })}
        </>
      )}
      {error && (
        <>
          <p className="error">{error}</p>
          {/* v0.71 (audit): the tools load had a loading line and an
              error but no retry — switching bots was the only reload. */}
          <button className="btn secondary" data-testid="tools-retry" onClick={() => botId && void load(botId)}>
            {t('tools.retry')}
          </button>
        </>
      )}
      {botId && !loading && skillsData && (
        <>
          <h3>{t('tools.skillsTitle')}</h3>
          <p style={{ color: 'var(--text-dim)' }}>
            {t('tools.skillsSummary', {
              enabled: skillsData.enabledSkills,
              total: skillsData.totalSkills,
            })}
          </p>
          {skillsData.skills.length === 0 && (
            <p className="empty">{t('tools.skillsEmpty')}</p>
          )}
          {skillsData.skills.map((skill) => (
            <div
              key={skill.name}
              data-testid={`skill-row-${skill.name}`}
              style={{
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: 12,
                marginBottom: 8,
                opacity: skill.enabled ? 1 : 0.6,
              }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <code style={{ fontWeight: 600 }}>{skill.name}</code>
                {skill.context === 'fork' && <span className="badge">{t('tools.skillFork')}</span>}
                {!skill.globallyEnabled && (
                  <span className="badge">{t('tools.skillDisabledGlobally')}</span>
                )}
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
                  <input
                    data-testid={`skill-toggle-${skill.name}`}
                    type="checkbox"
                    checked={skill.enabled}
                    disabled={busySkill === skill.name || !skill.globallyEnabled}
                    onChange={() => void toggleSkill(skill)}
                  />
                  {skill.enabled ? t('tools.enabled') : t('tools.disabled')}
                </label>
              </div>
              {skill.description && (
                <p style={{ margin: '6px 0 0', color: 'var(--text-dim)' }}>{skill.description}</p>
              )}
            </div>
          ))}
        </>
      )}
      {skillsError && (
        <>
          <p className="error">{skillsError}</p>
          {/* v0.71 (audit): same retry as the tools load above — one
              load() reloads both lists. */}
          <button className="btn secondary" data-testid="tools-skills-retry" onClick={() => botId && void load(botId)}>
            {t('tools.retry')}
          </button>
        </>
      )}
    </div>
  );
}
