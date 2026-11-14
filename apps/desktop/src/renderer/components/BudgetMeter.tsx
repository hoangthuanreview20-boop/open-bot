import type { BudgetSnapshotView } from '../types';
import { useT } from '../i18n/useT';

interface Props {
  /** Budget snapshot of the open conversation (null = no data yet). */
  snapshot: BudgetSnapshotView | null;
  /** Name of the bot shown (to tell bots apart when switching). */
  botName?: string;
}

function formatCost(costUsd: number | null, hasUnknownCost: boolean): string {
  if (costUsd === null) return hasUnknownCost ? '?' : '$0.00';
  return `$${costUsd.toFixed(4)}`;
}

function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * BudgetMeter (v1.01, Team T3) — token + estimated-cost meter for the
 * open conversation. Shows a progress bar for % used vs the cap (the
 * max of the token / cost caps), in/out token counts, estimated cost
 * (or `?` when a model has no known price — never a fake $0), and the
 * warning/exceeded state past a threshold. With no caps it just counts
 * (progress bar hidden, numbers only).
 */
export default function BudgetMeter({ snapshot, botName }: Props) {
  const t = useT();
  if (!snapshot) return null;
  const percent = snapshot.percentUsed;
  const barColor =
    snapshot.status === 'exceeded' ? '#c0392b' : snapshot.status === 'warning' ? '#d48806' : '#2e7d32';
  const statusKey =
    snapshot.status === 'exceeded'
      ? 'budget.exceeded'
      : snapshot.status === 'warning'
        ? 'budget.warning'
        : 'budget.ok';
  return (
    <div
      data-testid="budget-meter"
      style={{
        margin: '0 0 8px',
        padding: '8px 10px',
        borderRadius: 8,
        border: `1px solid ${snapshot.status === 'ok' ? '#d8d8d8' : barColor}`,
        background: snapshot.status === 'ok' ? 'transparent' : snapshot.status === 'exceeded' ? '#fdecea' : '#fef6e0',
        fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <strong>
          {t('budget.title')}
          {botName ? ` — ${botName}` : ''}
        </strong>
        <span style={{ color: barColor, fontWeight: 600 }}>{t(statusKey)}</span>
      </div>
      {percent !== null && (
        <div
          role="progressbar"
          aria-valuenow={Math.round(percent)}
          aria-valuemin={0}
          aria-valuemax={100}
          style={{ height: 8, borderRadius: 4, background: '#e8e8e8', marginTop: 6, overflow: 'hidden' }}
        >
          <div
            style={{
              width: `${Math.min(100, percent)}%`,
              height: '100%',
              background: barColor,
              transition: 'width 0.3s',
            }}
          />
        </div>
      )}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 6 }}>
        <span>
          {t('budget.tokens', {
            total: formatTokens(snapshot.totalTokens),
            input: formatTokens(snapshot.inputTokens),
            output: formatTokens(snapshot.outputTokens),
          })}
        </span>
        <span>
          {t('budget.cost', { cost: formatCost(snapshot.costUsd, snapshot.hasUnknownCost) })}
          {snapshot.hasUnknownCost ? ` ${t('budget.unknownCostHint')}` : ''}
        </span>
        {snapshot.tokenLimit !== null && (
          <span>
            {t('budget.tokenLimit', {
              limit: formatTokens(snapshot.tokenLimit),
              percent: percent !== null ? Math.round(percent) : 0,
            })}
          </span>
        )}
        {snapshot.costLimitUsd !== null && (
          <span>{t('budget.costLimit', { limit: `$${snapshot.costLimitUsd.toFixed(2)}` })}</span>
        )}
        {snapshot.model && <span>{t('budget.model', { model: snapshot.model })}</span>}
      </div>
    </div>
  );
}
