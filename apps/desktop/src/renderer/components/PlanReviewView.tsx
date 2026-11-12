/**
 * PlanReviewView — plan review screen (v0.11, P0-3).
 *
 * Pending plans arrive from App: when the agent (plan mode) calls
 * plan_create, its tool result (JSON with projectId, filePath, steps,
 * decisions, status "pending") is caught from the `chat:toolresult`
 * event and kept in App state — no new IPC (main.ts is untouched).
 *
 * v0.20 (W13a): the three decisions go DIRECTLY to the coordinator via
 * the `plans:review` IPC (coordinator RPC `reviewPlan`) instead of
 * through chat — no `plan_update` tool-call runs, so no approval card
 * ever appears for the review action itself. The RPC writes the
 * decision to memory + the plan file, and only approve records the
 * plan-approved mark (the next run then auto-approves its tool calls).
 * `plan_update` stays a tool for the agent: when the agent itself
 * reviews a plan inside a run, its approval card still appears as usual.
 * After approve / request-changes App also sends one chat message so
 * the agent executes / revises the plan; reject needs no follow-up run.
 *
 * Note: plan_create / plan_update both have needsApproval: true, so
 * agent-initiated plan calls still show an approval card under the chat.
 * Plans that were already decided leave this list.
 *
 * Plans submitted in an earlier session (before the app restarted) are
 * loaded back from disk through the `plans:list` IPC (main reads
 * `<workspace>/.open-bot/plans/*.md`) and merged with the session plans
 * below — same projectId keeps only the newest copy. A stored plan whose
 * file already records a decision (approved / rejected /
 * changes-requested) is dropped from the list, as is a session plan for
 * the same projectId.
 */
import { useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n/useT';

export interface PendingPlan {
  projectId: string;
  botId: string;
  title: string;
  detail?: string;
  /** Absolute path of the plan Markdown file (null when not written). */
  filePath: string | null;
  steps: string[];
  decisions: string[];
  status: 'pending' | 'approved' | 'rejected' | 'changes-requested';
  createdAt?: string;
  /** Last-modified time (plan files on disk); used to pick the newest copy. */
  updatedAt?: string;
  /**
   * v0.79b: diff against the previous version (only stored plans have
   * one — computed in main from the newest history snapshot). Session
   * plans (fresh from the agent) have no previous version to diff.
   */
  diff?: {
    steps: { added: string[]; removed: string[]; unchanged: string[] };
    decisions: { added: string[]; removed: string[]; unchanged: string[] };
  };
}

interface Props {
  plans: PendingPlan[];
  botName: string | null;
  /** Bot whose stored plans to load; falls back to the session plans' bot. */
  botId?: string | null;
  onBack: () => void;
  /** v0.20: resolve when the direct `plans:review` RPC succeeded; reject on error (the card then shows it and keeps the plan). */
  onApprove: (plan: PendingPlan) => Promise<void>;
  onReject: (plan: PendingPlan) => Promise<void>;
  onRequestChanges: (plan: PendingPlan, note: string) => Promise<void>;
}

function formatTime(iso: string | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function PlanCard({
  plan,
  onApprove,
  onReject,
  onRequestChanges,
}: {
  plan: PendingPlan;
  onApprove: (plan: PendingPlan) => Promise<void>;
  onReject: (plan: PendingPlan) => Promise<void>;
  onRequestChanges: (plan: PendingPlan, note: string) => Promise<void>;
}) {
  const t = useT();
  const [note, setNote] = useState('');
  const [decided, setDecided] = useState<string | null>(null);
  // v0.20: the review RPC can fail (plan already decided elsewhere,
  // bot gone) — show the error and KEEP the buttons so the user can retry.
  const [reviewError, setReviewError] = useState<string | null>(null);

  // The "decided" notice only appears after the RPC succeeded; the
  // parent removes the plan from the list right after, so the notice is
  // mostly visible for stored plans while the list refreshes.
  const decide = (fn: () => Promise<void>, noticeKey: 'plan.approvedNotice' | 'plan.rejectedNotice' | 'plan.changesNotice') => {
    setReviewError(null);
    void fn()
      .then(() => setDecided(t(noticeKey)))
      .catch(() => setReviewError(t('plan.reviewError')));
  };

  return (
    <li>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>{plan.title}</strong>
        <span className="badge running">{t('plan.pendingBadge')}</span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
        project {plan.projectId}
        {plan.filePath ? ` · file ${plan.filePath}` : ` · ${t('plan.fileMissing')}`}
        {plan.createdAt ? ` · ${formatTime(plan.createdAt)}` : ''}
      </div>
      {plan.detail && (
        <p style={{ fontSize: 13, margin: '8px 0 0', whiteSpace: 'pre-wrap' }}>{plan.detail}</p>
      )}
      {/* v0.79b: what changed since the previous version — a collapsed
          <details> so the review screen stays scannable; added lines in
          green with "+", removed lines struck through with "−". Only
          stored plans carry a diff. */}
      {plan.diff && (
        <details data-testid="plan-diff" style={{ marginTop: 12 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            {t('plan.diffTitle')} —{' '}
            {t('plan.diffSummary', {
              added: String(plan.diff.steps.added.length + plan.diff.decisions.added.length),
              removed: String(plan.diff.steps.removed.length + plan.diff.decisions.removed.length),
              unchanged: String(plan.diff.steps.unchanged.length + plan.diff.decisions.unchanged.length),
            })}
          </summary>
          {plan.diff.steps.added.length + plan.diff.decisions.added.length +
            plan.diff.steps.removed.length + plan.diff.decisions.removed.length === 0 ? (
            <p style={{ fontSize: 13, margin: '8px 0 0', color: 'var(--text-dim)' }}>
              {t('plan.diffNoChanges')}
            </p>
          ) : (
            <>
              {plan.diff.steps.added.length > 0 && (
                <>
                  <h4 style={{ margin: '12px 0 4px' }}>{t('plan.diffAddedSteps')}</h4>
                  <ul style={{ margin: '0 0 4px', paddingLeft: 20, fontSize: 13 }}>
                    {plan.diff.steps.added.map((s, i) => (
                      <li key={i} style={{ marginBottom: 2, color: 'var(--ok)' }}>+ {s}</li>
                    ))}
                  </ul>
                </>
              )}
              {plan.diff.steps.removed.length > 0 && (
                <>
                  <h4 style={{ margin: '12px 0 4px' }}>{t('plan.diffRemovedSteps')}</h4>
                  <ul style={{ margin: '0 0 4px', paddingLeft: 20, fontSize: 13 }}>
                    {plan.diff.steps.removed.map((s, i) => (
                      <li key={i} style={{ marginBottom: 2, color: 'var(--danger)' }}>
                        <s>− {s}</s>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {plan.diff.decisions.added.length > 0 && (
                <>
                  <h4 style={{ margin: '12px 0 4px' }}>{t('plan.diffAddedDecisions')}</h4>
                  <ul style={{ margin: '0 0 4px', paddingLeft: 20, fontSize: 13 }}>
                    {plan.diff.decisions.added.map((s, i) => (
                      <li key={i} style={{ marginBottom: 2, color: 'var(--ok)' }}>+ {s}</li>
                    ))}
                  </ul>
                </>
              )}
              {plan.diff.decisions.removed.length > 0 && (
                <>
                  <h4 style={{ margin: '12px 0 4px' }}>{t('plan.diffRemovedDecisions')}</h4>
                  <ul style={{ margin: '0 0 4px', paddingLeft: 20, fontSize: 13 }}>
                    {plan.diff.decisions.removed.map((s, i) => (
                      <li key={i} style={{ marginBottom: 2, color: 'var(--danger)' }}>
                        <s>− {s}</s>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </details>
      )}
      <h4 style={{ margin: '12px 0 4px' }}>{t('plan.steps', { count: String(plan.steps.length) })}</h4>
      {plan.steps.length === 0 ? (
        <p className="empty">{t('plan.noSteps')}</p>
      ) : (
        <ol style={{ margin: '0 0 4px', paddingLeft: 20, fontSize: 13 }}>
          {plan.steps.map((s, i) => (
            <li key={i} style={{ marginBottom: 2 }}>
              {s}
            </li>
          ))}
        </ol>
      )}
      <h4 style={{ margin: '12px 0 4px' }}>{t('plan.decisions')}</h4>
      {plan.decisions.length === 0 ? (
        <p style={{ fontSize: 13, margin: '0 0 4px', color: 'var(--text-dim)' }}>
          {t('plan.noDecisions')}
        </p>
      ) : (
        <ul style={{ margin: '0 0 4px', paddingLeft: 20, fontSize: 13 }}>
          {plan.decisions.map((d, i) => (
            <li key={i} style={{ marginBottom: 2 }}>
              {d}
            </li>
          ))}
        </ul>
      )}
      {decided ? (
        <p className="notice summary" style={{ margin: '12px 0 0' }}>
          {decided}
        </p>
      ) : (
        <>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('plan.notePlaceholder')}
            rows={2}
            style={{ width: '100%', marginTop: 12, resize: 'vertical' }}
          />
          {reviewError && (
            <p className="notice" style={{ margin: '8px 0 0' }}>
              {reviewError}
            </p>
          )}
          <div className="row" style={{ marginTop: 8, gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn ok"
              onClick={() => decide(() => onApprove(plan), 'plan.approvedNotice')}
            >
              {t('plan.approve')}
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => decide(() => onReject(plan), 'plan.rejectedNotice')}
            >
              {t('plan.reject')}
            </button>
            <button
              type="button"
              className="btn secondary"
              disabled={note.trim().length === 0}
              onClick={() => decide(() => onRequestChanges(plan, note.trim()), 'plan.changesNotice')}
            >
              {t('plan.requestChanges')}
            </button>
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: '8px 0 0' }}>
            {t('plan.hint')}
          </p>
        </>
      )}
    </li>
  );
}

export default function PlanReviewView({
  plans,
  botName,
  botId,
  onBack,
  onApprove,
  onReject,
  onRequestChanges,
}: Props) {
  const t = useT();
  // Plans from previous sessions, loaded from disk (see `plans:list`).
  const [storedPlans, setStoredPlans] = useState<PendingPlan[]>([]);
  const [loadingStored, setLoadingStored] = useState(false);
  const [storedError, setStoredError] = useState(false);
  // Which bot to ask `plans:list` about: the prop when given, else the
  // bot of the session plans, else every bot (no botId sent).
  const sessionBotId = plans.length > 0 ? plans[0].botId : '';
  const effectiveBotId = botId ?? (sessionBotId || undefined);

  useEffect(() => {
    let cancelled = false;
    setLoadingStored(true);
    setStoredError(false);
    window.openBot['plans:list'](effectiveBotId ? { botId: effectiveBotId } : undefined)
      .then((listed) => {
        if (cancelled) return;
        setStoredPlans(
          listed.map((s) => ({
            projectId: s.projectId,
            botId: s.botId,
            title: s.title,
            detail: s.detail,
            filePath: s.filePath,
            steps: s.steps,
            decisions: s.decisions,
            status: s.status,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
            // v0.79b: carry the diff through so PlanCard can render it.
            diff: s.diff,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setStoredError(true);
      })
      .finally(() => {
        if (!cancelled) setLoadingStored(false);
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveBotId]);

  // Session plans first (existing order), then stored plans not already
  // in the session. A stored plan with the same projectId replaces the
  // session copy only when it is newer (file mtime beats a session plan
  // without a timestamp).
  // v0.20: a stored plan whose file already records a decision is
  // dropped, and so is a session plan for the same projectId (it was
  // decided elsewhere, e.g. by the agent's own plan_update in chat) —
  // decided plans leave this list instead of showing a "pending" badge.
  const mergedPlans = useMemo(() => {
    const tsOf = (p: PendingPlan): number => {
      const parsed = Date.parse(p.updatedAt ?? p.createdAt ?? '');
      return Number.isNaN(parsed) ? 0 : parsed;
    };
    const decidedIds = new Set(
      storedPlans.filter((s) => s.status !== 'pending').map((s) => s.projectId),
    );
    const merged = plans.filter((p) => !decidedIds.has(p.projectId));
    const indexById = new Map(merged.map((p, i) => [p.projectId, i]));
    for (const stored of storedPlans) {
      if (stored.status !== 'pending') continue;
      const i = indexById.get(stored.projectId);
      if (i === undefined) {
        indexById.set(stored.projectId, merged.length);
        merged.push(stored);
      } else if (tsOf(stored) > tsOf(merged[i])) {
        merged[i] = stored;
      }
    }
    return merged;
  }, [plans, storedPlans]);

  // A decision on a stored plan removes it from this list as well, so it
  // behaves exactly like a session plan (App removes session plans from
  // its own state). The stored copy is only removed AFTER the review RPC
  // succeeds — on failure the plan stays so the user can retry.
  const handleApprove = async (plan: PendingPlan) => {
    await onApprove(plan);
    setStoredPlans((prev) => prev.filter((p) => p.projectId !== plan.projectId));
  };
  const handleReject = async (plan: PendingPlan) => {
    await onReject(plan);
    setStoredPlans((prev) => prev.filter((p) => p.projectId !== plan.projectId));
  };
  const handleRequestChanges = async (plan: PendingPlan, note: string) => {
    await onRequestChanges(plan, note);
    setStoredPlans((prev) => prev.filter((p) => p.projectId !== plan.projectId));
  };

  return (
    <div className="panel">
      <button className="btn secondary" onClick={onBack}>
        {t('plan.back')}
      </button>
      <h2>{t('plan.title')}</h2>
      <p>
        {botName ? `Bot ${botName} — ` : ''}
        {t('plan.intro')}
      </p>
      {loadingStored && <p className="empty">{t('plan.loading')}</p>}
      {storedError && <p className="notice">{t('plan.loadError')}</p>}
      {mergedPlans.length === 0 && !loadingStored && (
        <p className="empty">
          {t('plan.emptyLine1')}
          <br />
          {t('plan.emptyLine2')}
        </p>
      )}
      {mergedPlans.length > 0 && (
        <ul className="task-list">
          {mergedPlans.map((plan) => (
            <PlanCard
              key={plan.projectId}
              plan={plan}
              onApprove={handleApprove}
              onReject={handleReject}
              onRequestChanges={handleRequestChanges}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
