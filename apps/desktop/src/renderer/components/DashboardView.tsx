/**
 * DashboardView (v0.96, Team T6) — the overview screen.
 *
 * One glance at the whole app: how many bots, how many runs today,
 * estimated tokens, memory blocks, router decisions, Composio
 * connections, automations — plus the top tools today and a per-bot
 * table. Everything comes from stores the app already has
 * (harness thread log, usage, memory status, Composio state,
 * automations); the view makes no network call and adds no IPC.
 *
 * A source that is unavailable (preload not exposing it yet, or an
 * IPC error) contributes nothing instead of breaking the screen —
 * the card shows "—" and the view still renders the rest.
 */
import { useEffect, useState } from 'react';
import type {
  BotConfigLike,
  ComposioStateView,
  HarnessThreadLogView,
  SpendStatusData,
} from '../types';
import { useT } from '../i18n/useT';
import { aggregateDashboard, type DashboardLogEntry, type DashboardStats } from './dashboardStats';

interface Props {
  bots: BotConfigLike[];
  onBack: () => void;
  onOpenBot: (botId: string) => void;
  onOpenEventLog: () => void;
  onOpenMemory: () => void;
  onOpenAutomations: () => void;
  onOpenConnectedApps: () => void;
}

const LOG_LIMIT = 100;

async function callOpenBot<T>(method: string, ...args: unknown[]): Promise<T | null> {
  const api = window.openBot as unknown as Record<string, unknown>;
  const fn = api[method];
  if (typeof fn !== 'function') return null;
  try {
    return (await (fn as (...a: unknown[]) => Promise<T>).apply(window.openBot, args)) as T;
  } catch {
    return null;
  }
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatCost(costUsd: number | null): string {
  if (costUsd === null) return '—';
  return `$${costUsd.toFixed(2)}`;
}

export default function DashboardView({
  bots,
  onBack,
  onOpenBot,
  onOpenEventLog,
  onOpenMemory,
  onOpenAutomations,
  onOpenConnectedApps,
}: Props) {
  const t = useT();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const entries: DashboardLogEntry[] = [];
      const usageByBot: Record<string, { today?: { inputTokens?: number; outputTokens?: number; costUsd?: number | null } }> = {};
      const memoryBlocksByBot: Record<string, number> = {};
      await Promise.all(
        bots.map(async (bot) => {
          const [usage, log, memory] = await Promise.all([
            callOpenBot<SpendStatusData>('getUsage', bot.id),
            callOpenBot<HarnessThreadLogView>('getHarnessThreadLog', {
              threadId: bot.id,
              limit: LOG_LIMIT,
            }),
            callOpenBot<{ total: number }>('getMemoryStatus', { botId: bot.id }),
          ]);
          if (usage?.today) {
            usageByBot[bot.id] = {
              today: {
                inputTokens: usage.today.inputTokens,
                outputTokens: usage.today.outputTokens,
                costUsd: usage.today.costUsd,
              },
            };
          }
          if (typeof memory?.total === 'number') memoryBlocksByBot[bot.id] = memory.total;
          for (const entry of log?.entries ?? []) {
            entries.push({
              at: entry.at,
              botId: entry.botId,
              kind: entry.kind,
              payload: entry.payload,
            });
          }
        }),
      );
      const [composio, automations] = await Promise.all([
        callOpenBot<ComposioStateView>('getComposioState'),
        callOpenBot<unknown[]>('listAutomations'),
      ]);
      if (!alive) return;
      setStats(
        aggregateDashboard({
          entries,
          botIds: bots.map((b) => b.id),
          usageByBot,
          memoryBlocksByBot,
          composioApps: composio?.apps ?? [],
          automationsTotal: Array.isArray(automations) ? automations.length : 0,
        }),
      );
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [bots]);

  const botName = (botId: string): string =>
    bots.find((b) => b.id === botId)?.name ?? botId;

  const cards: Array<{ label: string; value: string; hint?: string; onClick?: () => void }> = stats
    ? [
        { label: t('dashboard.bots'), value: formatNumber(stats.botsTotal) },
        { label: t('dashboard.runsToday'), value: formatNumber(stats.runsToday) },
        {
          label: t('dashboard.tokensToday'),
          value: formatNumber(stats.tokensToday),
          hint: formatCost(stats.costUsdToday),
        },
        { label: t('dashboard.toolCallsToday'), value: formatNumber(stats.toolCallsToday) },
        { label: t('dashboard.errorsToday'), value: formatNumber(stats.errorsToday) },
        {
          label: t('dashboard.memoryBlocks'),
          value: formatNumber(stats.memoryBlocks),
          onClick: onOpenMemory,
        },
        {
          label: t('dashboard.routerDecisions'),
          value: formatNumber(stats.routerDecisions),
          hint: t('dashboard.routerDecisionsToday', { count: String(stats.routerDecisionsToday) }),
        },
        {
          label: t('dashboard.composioConnected'),
          value: formatNumber(stats.composioConnected),
          onClick: onOpenConnectedApps,
        },
        {
          label: t('dashboard.automations'),
          value: formatNumber(stats.automationsTotal),
          onClick: onOpenAutomations,
        },
      ]
    : [];

  return (
    <div className="main" data-testid="dashboard-view">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{t('dashboard.title')}</h2>
        <button className="btn secondary" onClick={onBack}>
          {t('dashboard.back')}
        </button>
      </div>
      {loading && <p className="empty">{t('dashboard.loading')}</p>}
      {!loading && stats && (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
              gap: 12,
              marginTop: 16,
            }}
          >
            {cards.map((card) => (
              <div
                key={card.label}
                data-testid="dashboard-card"
                onClick={card.onClick}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: '12px 14px',
                  cursor: card.onClick ? 'pointer' : 'default',
                }}
              >
                <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{card.label}</div>
                <div style={{ fontSize: 24, fontWeight: 600, marginTop: 4 }}>{card.value}</div>
                {card.hint && (
                  <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>
                    {card.hint}
                  </div>
                )}
              </div>
            ))}
          </div>

          <h3 style={{ marginTop: 24 }}>{t('dashboard.topToolsToday')}</h3>
          {stats.topToolsToday.length === 0 ? (
            <p className="empty">{t('dashboard.noToolCallsToday')}</p>
          ) : (
            <ul style={{ margin: '8px 0', paddingLeft: 20 }}>
              {stats.topToolsToday.map((row) => (
                <li key={row.tool}>
                  <code>{row.tool}</code> — {t('dashboard.callsCount', { count: String(row.calls) })}
                </li>
              ))}
            </ul>
          )}

          <h3 style={{ marginTop: 24 }}>{t('dashboard.perBotToday')}</h3>
          {stats.runsTodayByBot.length === 0 ? (
            <p className="empty">{t('dashboard.noBots')}</p>
          ) : (
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--text-dim)', fontSize: 12 }}>
                  <th style={{ padding: '6px 8px' }}>{t('dashboard.botColumn')}</th>
                  <th style={{ padding: '6px 8px' }}>{t('dashboard.runsColumn')}</th>
                  <th style={{ padding: '6px 8px' }}>{t('dashboard.toolCallsColumn')}</th>
                  <th style={{ padding: '6px 8px' }}>{t('dashboard.errorsColumn')}</th>
                </tr>
              </thead>
              <tbody>
                {stats.runsTodayByBot.map((row) => (
                  <tr key={row.botId} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px 8px' }}>
                      <button
                        type="button"
                        className="btn secondary"
                        style={{ padding: '2px 8px' }}
                        onClick={() => onOpenBot(row.botId)}
                      >
                        {botName(row.botId)}
                      </button>
                    </td>
                    <td style={{ padding: '6px 8px' }}>{row.runs}</td>
                    <td style={{ padding: '6px 8px' }}>{row.toolCalls}</td>
                    <td style={{ padding: '6px 8px' }}>{row.errors}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p style={{ marginTop: 16 }}>
            <button className="btn secondary" onClick={onOpenEventLog}>
              {t('dashboard.openEventLog')}
            </button>
          </p>
        </>
      )}
    </div>
  );
}
