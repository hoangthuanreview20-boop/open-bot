/**
 * PlanView (v0.96, Team T6) — the planning screen.
 *
 * Plans live in localStorage (`open-bot:plans-v096`, see planStore)
 * so the screen works with no new IPC and no server: a plan is a
 * title plus ordered steps, each step has a lifecycle
 * (pending → running → done / failed / skipped) and can be assigned
 * to a bot. "Dispatch next step" claims the next step for the
 * selected bot — its own assigned step first, then the oldest
 * unassigned one — so one plan can fan out across the bots in a
 * group without the model tracking state in prose.
 *
 * The stuck banner is the point: when the recorded tool calls for
 * the running step repeat the same call 3x, or 3 steps in a row
 * finish without progress, the view says so and offers the next
 * move (try another tool, ask the user, skip the step) instead of
 * letting the run spin. The store never stops a run by itself.
 *
 * v0.98 (Team T4 — planning v2): live run binding. Plans created
 * in the coordinator (from a template, or by another surface) load
 * on open, resume after a restart, and follow the live run through
 * `plan:event` — step state, progress and stuck status update from
 * events alone, no polling. A stuck run can propose a replan the
 * user approves or rejects here, and a plan can be attached to the
 * next chat run (`onRunPlanChange`) so the run executes its steps.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BotConfigLike } from '../types';
import { useT } from '../i18n/useT';
import {
  PLAN_STORE_KEY,
  addUiPlan,
  addUiStep,
  applyPlanEvent,
  assignUiStep,
  checkUiPlanStuck,
  completeUiStep,
  createUiPlan,
  deleteUiPlan,
  dispatchUiStep,
  emptyPlanStore,
  failUiStep,
  mergeRunPlans,
  parsePlanStore,
  planProgressOf,
  retryUiStep,
  skipUiStep,
  startUiStep,
  stringifyPlanStore,
  type PlanStore,
  type UiPlan,
  type UiPlanRunEvent,
  type UiPlanStep,
  type UiReplanProposal,
  type UiStuckReason,
  type UiStuckReport,
} from './planStore';

interface PlanTemplateOption {
  id: string;
  title: string;
  stepCount: number;
  variables: Array<{ name: string; required: boolean; hint: string }>;
}

interface Props {
  bots: BotConfigLike[];
  onBack: () => void;
  /** Plan currently attached to the next chat run (v0.98). */
  activeRunPlanId?: string | null;
  onRunPlanChange?: (planId: string | null, botId: string | null, title?: string | null) => void;
}

function safeLocalStorage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

const STATUS_ICON: Record<UiPlanStep['status'], string> = {
  pending: '○',
  running: '▶',
  done: '✓',
  failed: '✗',
  skipped: '→',
};

export default function PlanView({ bots, onBack, activeRunPlanId, onRunPlanChange }: Props) {
  const t = useT();
  const [store, setStore] = useState<PlanStore>(() => {
    const storage = safeLocalStorage();
    return parsePlanStore(storage?.getItem(PLAN_STORE_KEY) ?? null);
  });
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [newDetail, setNewDetail] = useState('');
  const [newSteps, setNewSteps] = useState('');
  const [newStepTitle, setNewStepTitle] = useState('');
  const [dispatchBotId, setDispatchBotId] = useState('');
  const [notice, setNotice] = useState('');
  // v0.98 (Team T4 — planning v2): run-bound plans from the coordinator.
  const [templates, setTemplates] = useState<PlanTemplateOption[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [templateVars, setTemplateVars] = useState<Record<string, string>>({});
  const [runPlanBotId, setRunPlanBotId] = useState('');
  const [runBusy, setRunBusy] = useState(false);
  const runLoadedRef = useRef(false);

  useEffect(() => {
    try {
      safeLocalStorage()?.setItem(PLAN_STORE_KEY, stringifyPlanStore(store));
    } catch {
      // Storage unavailable — the plans still work for this session.
    }
  }, [store]);

  // v0.98: load coordinator run plans once (list + resume after a
  // restart), then follow the live run through `plan:event` — no
  // polling. Every step is guarded: if the coordinator API is
  // unavailable the local plans still work exactly as before.
  useEffect(() => {
    if (runLoadedRef.current) return;
    runLoadedRef.current = true;
    const api = window.openBot;
    if (!api || typeof api.listRunPlans !== 'function') return;
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      try {
        const listed = await api.listRunPlans();
        let resumedIds = new Set<string>();
        let resumedViews: typeof listed.plans = [];
        let untouchedViews: typeof listed.plans = [];
        try {
          const resumed = await api.resumeRunPlans();
          resumedIds = new Set(resumed.resumed.map((v) => v.plan.id));
          resumedViews = resumed.resumed;
          untouchedViews = resumed.untouched;
        } catch {
          // Resume is best-effort — the list above is enough.
        }
        setStore((prev) => {
          const merged = mergeRunPlans(
            prev,
            [...listed.plans, ...resumedViews, ...untouchedViews],
            resumedIds,
          );
          // Reconcile: a remote plan the coordinator no longer lists
          // is stale — drop its live flags instead of showing a run
          // that no longer exists.
          const known = new Set(
            [...listed.plans, ...resumedViews, ...untouchedViews].map((v) => v.plan.id),
          );
          return {
            ...merged,
            plans: merged.plans.map((p) =>
              p.remote && !known.has(p.id)
                ? { ...p, live: false, runId: null, stuck: null, replanProposal: null }
                : p,
            ),
          };
        });
      } catch {
        setNotice(t('planner.loadError'));
      }
      try {
        const { templates: found } = await api.listPlanTemplates();
        setTemplates(found);
      } catch {
        // Templates are optional — manual plans still work.
      }
    })();
    try {
      if (typeof api.onPlanEvent === 'function') {
        unsubscribe = api.onPlanEvent((event) => {
          setStore((prev) => applyPlanEvent(prev, event as unknown as UiPlanRunEvent));
        });
      }
    } catch {
      // Live events are optional — the list above is the fallback.
    }
    return () => {
      try {
        unsubscribe?.();
      } catch {
        // Unsubscribe is best-effort.
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedPlan: UiPlan | null =
    store.plans.find((p) => p.id === selectedPlanId) ?? store.plans[0] ?? null;

  const stuck: UiStuckReport | null = useMemo(() => {
    if (!selectedPlan) return null;
    try {
      const running = selectedPlan.steps.find((s) => s.status === 'running');
      return checkUiPlanStuck(store, selectedPlan.id, running?.id);
    } catch {
      return null;
    }
  }, [store, selectedPlan]);

  const progress = selectedPlan ? planProgressOf(selectedPlan) : null;

  // v0.98: a live stuck report from the run wins over the locally
  // computed one (remote plans have no local tool history).
  const stuckShown: UiStuckReport | null = selectedPlan?.stuck ?? stuck;

  const stuckReasonLabel = (reason: UiStuckReason): string => {
    switch (reason) {
      case 'repeated-tool-call':
        return t('planner.stuckRepeated');
      case 'no-progress':
        return t('planner.stuckNoProgress');
      case 'stall':
        return t('planner.stuckStall');
      case 'error-repeat':
        return t('planner.stuckErrorRepeat');
      case 'tool-cycle':
        return t('planner.stuckToolCycle');
    }
  };

  const update = (next: PlanStore) => setStore(next);

  const createPlan = () => {
    try {
      const plan = createUiPlan(newTitle, {
        detail: newDetail || undefined,
        steps: newSteps.split('\n'),
      });
      update(addUiPlan(store, plan));
      setSelectedPlanId(plan.id);
      setNewTitle('');
      setNewDetail('');
      setNewSteps('');
      setNotice('');
    } catch (e) {
      setNotice(e instanceof Error ? e.message : t('planner.createError'));
    }
  };

  // v0.98: create the plan in the coordinator (not localStorage) so a
  // real run can execute its steps. The coordinator persists it under
  // `<userData>/run-plans/` and reports progress via `plan:event`.
  const createRunPlan = async () => {
    if (!runPlanBotId || runBusy) return;
    setRunBusy(true);
    try {
      const { plan } = await window.openBot.createRunPlan({
        botId: runPlanBotId,
        title: newTitle,
        detail: newDetail || undefined,
        steps: newSteps.split('\n'),
      });
      setStore((prev) =>
        mergeRunPlans(prev, [
          {
            plan: plan as unknown as UiPlan,
            runId: null,
            botId: runPlanBotId,
            templateId: null,
            proposals: [],
          },
        ]),
      );
      setSelectedPlanId(plan.id);
      setNewTitle('');
      setNewDetail('');
      setNewSteps('');
      setNotice('');
    } catch (e) {
      setNotice(e instanceof Error ? e.message : t('planner.createError'));
    } finally {
      setRunBusy(false);
    }
  };

  // v0.98: create a run plan from a coordinator template — the server
  // expands `{variables}` into the steps, so the UI only collects
  // the values.
  const createFromTemplate = async () => {
    const template = templates.find((x) => x.id === selectedTemplateId);
    if (!template || !runPlanBotId || runBusy) return;
    const vars: Record<string, string> = {};
    for (const [k, v] of Object.entries(templateVars)) {
      if (v.trim()) vars[k] = v.trim();
    }
    setRunBusy(true);
    try {
      const { plan } = await window.openBot.createRunPlan({
        botId: runPlanBotId,
        templateId: template.id,
        templateVars: vars,
      });
      setStore((prev) =>
        mergeRunPlans(prev, [
          {
            plan: plan as unknown as UiPlan,
            runId: null,
            botId: runPlanBotId,
            templateId: template.id,
            proposals: [],
          },
        ]),
      );
      setSelectedPlanId(plan.id);
      setSelectedTemplateId('');
      setTemplateVars({});
      setNotice('');
    } catch (e) {
      setNotice(e instanceof Error ? e.message : t('planner.createError'));
    } finally {
      setRunBusy(false);
    }
  };

  // v0.98: answer a pending replan proposal from the live run. The
  // coordinator applies the decision and returns the updated plan
  // snapshot — merging it clears the proposal; the next `plan:event`
  // carries the live state from there.
  const decideProposal = async (decision: 'approve' | 'reject') => {
    const proposal = selectedPlan?.replanProposal;
    if (!proposal || runBusy) return;
    setRunBusy(true);
    try {
      const { plan } = await window.openBot.decideReplan({
        proposalId: proposal.id,
        decision,
        ...(selectedPlan?.runId ? { runId: selectedPlan.runId } : {}),
      });
      if (plan) {
        setStore((prev) =>
          mergeRunPlans(prev, [
            {
              plan: plan as unknown as UiPlan,
              runId: null,
              botId: selectedPlan?.ownerBotId ?? null,
              templateId: selectedPlan?.templateId ?? null,
              proposals: [],
            },
          ]),
        );
      }
      setNotice(t(decision === 'approve' ? 'planner.replanApproved' : 'planner.replanRejected'));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : t('planner.actionError'));
    } finally {
      setRunBusy(false);
    }
  };

  // v0.98: deleting a coordinator plan removes it server-side too;
  // a local-only plan is deleted from the store as before. An
  // attached plan is detached first so the next chat run is clean.
  const deleteSelected = async () => {
    if (!selectedPlan) return;
    if (selectedPlan.remote) {
      try {
        await window.openBot.deleteRunPlan(selectedPlan.id);
      } catch (e) {
        setNotice(e instanceof Error ? e.message : t('planner.actionError'));
        return;
      }
    }
    if (activeRunPlanId === selectedPlan.id) onRunPlanChange?.(null, null);
    update(deleteUiPlan(store, selectedPlan.id));
    setSelectedPlanId(null);
  };

  const stepAction = (fn: (s: PlanStore) => PlanStore) => {
    try {
      update(fn(store));
      setNotice('');
    } catch (e) {
      setNotice(e instanceof Error ? e.message : t('planner.actionError'));
    }
  };

  const dispatchNext = () => {
    if (!selectedPlan || !dispatchBotId) return;
    try {
      const { store: next, step } = dispatchUiStep(store, selectedPlan.id, dispatchBotId);
      update(next);
      setNotice(
        step
          ? t('planner.dispatched', { title: step.title })
          : t('planner.nothingToDispatch'),
      );
    } catch (e) {
      setNotice(e instanceof Error ? e.message : t('planner.actionError'));
    }
  };

  return (
    <div className="main" data-testid="plan-view">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{t('planner.title')}</h2>
        <button className="btn secondary" onClick={onBack}>
          {t('planner.back')}
        </button>
      </div>
      <p style={{ color: 'var(--text-dim)', margin: '8px 0 0' }}>{t('planner.intro')}</p>

      <h3 style={{ marginTop: 20 }}>{t('planner.createTitle')}</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 560 }}>
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder={t('planner.titlePlaceholder')}
          aria-label={t('planner.titlePlaceholder')}
          data-testid="plan-new-title"
        />
        <input
          value={newDetail}
          onChange={(e) => setNewDetail(e.target.value)}
          placeholder={t('planner.detailPlaceholder')}
          aria-label={t('planner.detailPlaceholder')}
        />
        <textarea
          value={newSteps}
          onChange={(e) => setNewSteps(e.target.value)}
          placeholder={t('planner.stepsPlaceholder')}
          aria-label={t('planner.stepsPlaceholder')}
          rows={4}
          data-testid="plan-new-steps"
        />
        <div>
          <button className="btn" onClick={createPlan} disabled={!newTitle.trim()} data-testid="plan-create">
            {t('planner.create')}
          </button>
        </div>
      </div>

      {/* v0.98: run-bound plan — the same title/steps, created in the
          coordinator so a real run executes them. */}
      <h3 style={{ marginTop: 20 }}>{t('planner.createRunPlan')}</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 560 }}>
        <select
          value={runPlanBotId}
          onChange={(e) => setRunPlanBotId(e.target.value)}
          aria-label={t('planner.runPlanBot')}
          data-testid="plan-run-bot"
        >
          <option value="">{t('planner.runPlanBotPlaceholder')}</option>
          {bots.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <div>
          <button
            className="btn"
            onClick={createRunPlan}
            disabled={!newTitle.trim() || !runPlanBotId || runBusy}
            data-testid="plan-create-run"
          >
            {t('planner.createRunPlan')}
          </button>
        </div>
      </div>

      {/* v0.98: create a run plan from a coordinator template. */}
      {templates.length > 0 && (
        <>
          <h3 style={{ marginTop: 20 }}>{t('planner.templatesTitle')}</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 560 }}>
            <select
              value={selectedTemplateId}
              onChange={(e) => {
                setSelectedTemplateId(e.target.value);
                setTemplateVars({});
              }}
              aria-label={t('planner.templatePlaceholder')}
              data-testid="plan-template-select"
            >
              <option value="">{t('planner.templatePlaceholder')}</option>
              {templates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.title} ({tpl.stepCount})
                </option>
              ))}
            </select>
            {selectedTemplateId && (
              <>
                <p style={{ color: 'var(--text-dim)', margin: '4px 0 0', fontSize: 13 }}>
                  {t('planner.templateVarsTitle')}
                </p>
                {templates
                  .find((x) => x.id === selectedTemplateId)
                  ?.variables.map((v) => (
                    <input
                      key={v.name}
                      value={templateVars[v.name] ?? ''}
                      onChange={(e) =>
                        setTemplateVars((prev) => ({ ...prev, [v.name]: e.target.value }))
                      }
                      placeholder={`${v.name}${v.required ? ' *' : ''}${v.hint ? ` — ${v.hint}` : ''}`}
                      aria-label={v.name}
                      data-testid={`plan-template-var-${v.name}`}
                    />
                  ))}
              </>
            )}
            <div>
              <button
                className="btn"
                onClick={createFromTemplate}
                disabled={!selectedTemplateId || !runPlanBotId || runBusy}
                data-testid="plan-create-template"
              >
                {t('planner.createFromTemplate')}
              </button>
            </div>
          </div>
        </>
      )}

      {notice && <p role="status" style={{ color: 'var(--text-dim)' }}>{notice}</p>}

      {store.plans.length > 0 && (
        <>
          <h3 style={{ marginTop: 24 }}>{t('planner.listTitle')}</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {store.plans.map((plan) => (
              <button
                key={plan.id}
                type="button"
                className="btn secondary"
                data-testid="plan-row"
                data-plan-id={plan.id}
                onClick={() => setSelectedPlanId(plan.id)}
                style={{
                  borderColor: selectedPlan?.id === plan.id ? 'var(--accent, #2563eb)' : undefined,
                }}
              >
                {plan.title} ({planProgressOf(plan).percent}%)
              </button>
            ))}
          </div>
        </>
      )}

      {selectedPlan && progress && (
        <div style={{ marginTop: 20 }} data-testid="plan-detail" data-plan-id={selectedPlan.id}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0 }}>{selectedPlan.title}</h3>
            <button
              className="btn danger"
              onClick={() => void deleteSelected()}
            >
              {t('planner.delete')}
            </button>
          </div>
          {/* v0.98: live binding badges + attach the plan to the next chat run. */}
          {(selectedPlan.remote || selectedPlan.live || selectedPlan.resumed) && (
            <div
              style={{
                display: 'flex',
                gap: 12,
                marginTop: 8,
                flexWrap: 'wrap',
                fontSize: 13,
                color: 'var(--text-dim)',
              }}
            >
              {selectedPlan.remote && <span data-testid="plan-badge-remote">● {t('planner.remotePlan')}</span>}
              {selectedPlan.live && <span data-testid="plan-badge-live">● {t('planner.liveRunning')}</span>}
              {selectedPlan.resumed && <span data-testid="plan-badge-resumed">● {t('planner.resumed')}</span>}
            </div>
          )}
          {selectedPlan.remote && (
            <div style={{ marginTop: 8 }}>
              <button
                className="btn secondary"
                onClick={() => {
                  if (activeRunPlanId === selectedPlan.id) {
                    onRunPlanChange?.(null, null);
                  } else {
                    onRunPlanChange?.(selectedPlan.id, selectedPlan.ownerBotId ?? null, selectedPlan.title);
                  }
                }}
                data-testid="plan-attach-run"
              >
                {activeRunPlanId === selectedPlan.id ? t('planner.detachRun') : t('planner.attachRun')}
              </button>
            </div>
          )}
          {selectedPlan.detail && <p style={{ color: 'var(--text-dim)' }}>{selectedPlan.detail}</p>}
          <div
            role="progressbar"
            aria-valuenow={progress.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            style={{
              height: 8,
              borderRadius: 4,
              background: 'var(--border)',
              marginTop: 8,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${progress.percent}%`,
                height: '100%',
                background: 'var(--accent, #2563eb)',
              }}
            />
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-dim)' }}>
            {t('planner.progress', {
              done: String(progress.done),
              total: String(progress.total),
              failed: String(progress.failed),
              skipped: String(progress.skipped),
            })}
          </p>

          {stuckShown && (
            <div
              role="alert"
              data-testid="plan-stuck-banner"
              style={{
                border: '1px solid #b45309',
                borderRadius: 8,
                padding: '10px 12px',
                marginTop: 8,
              }}
            >
              <strong>{t('planner.stuckTitle')}</strong>
              <div>{stuckReasonLabel(stuckShown.reason)}</div>
              <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>{stuckShown.detail}</div>
              <div style={{ fontSize: 13, marginTop: 4 }}>
                {t('planner.stuckSuggestions')}: {stuckShown.suggestions.map((s) => t(`planner.suggestion.${s}`)).join(' · ')}
              </div>
            </div>
          )}

          {/* v0.98: a pending replan proposal from the live run — the
              user approves or rejects it here; the coordinator applies
              the decision and the next plan:event refreshes the plan. */}
          {selectedPlan.replanProposal && (
            <div
              role="alert"
              data-testid="plan-replan-banner"
              style={{
                border: '1px solid #2563eb',
                borderRadius: 8,
                padding: '10px 12px',
                marginTop: 8,
              }}
            >
              <strong>{t('planner.replanTitle')}</strong>
              <div>{selectedPlan.replanProposal.summary}</div>
              <ul style={{ margin: '6px 0', paddingLeft: 18, fontSize: 13 }}>
                {selectedPlan.replanProposal.changes.map((c, i) => (
                  <li key={i}>
                    {t(`planner.replanChange.${c.type}`)}
                    {c.title ? `: ${c.title}` : ''} — {c.reason}
                  </li>
                ))}
              </ul>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button
                  className="btn"
                  onClick={() => void decideProposal('approve')}
                  disabled={runBusy}
                  data-testid="plan-replan-approve"
                >
                  {t('planner.replanApprove')}
                </button>
                <button
                  className="btn secondary"
                  onClick={() => void decideProposal('reject')}
                  disabled={runBusy}
                  data-testid="plan-replan-reject"
                >
                  {t('planner.replanReject')}
                </button>
              </div>
            </div>
          )}

          {/* v0.98: a coordinator plan's steps are driven by its run —
              manual dispatch would only mutate localStorage. */}
          {selectedPlan.remote ? (
            <p style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 12 }}>
              {t('planner.remoteManaged')}
            </p>
          ) : (
            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <select
                value={dispatchBotId}
                onChange={(e) => setDispatchBotId(e.target.value)}
                aria-label={t('planner.dispatchBot')}
                data-testid="plan-dispatch-bot"
              >
                <option value="">{t('planner.dispatchBotPlaceholder')}</option>
                {bots.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
              <button className="btn" onClick={dispatchNext} disabled={!dispatchBotId} data-testid="plan-dispatch">
                {t('planner.dispatchNext')}
              </button>
            </div>
          )}

          <ol style={{ marginTop: 16, paddingLeft: 20 }}>
            {selectedPlan.steps.map((step) => (
              <li key={step.id} data-testid="plan-step" data-step-id={step.id} style={{ marginBottom: 10 }}>
                <span style={{ marginRight: 8 }}>{STATUS_ICON[step.status]}</span>
                <strong>{step.title}</strong>
                <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>
                  {' '}
                  — {t(`planner.status.${step.status}`)}
                  {step.assigneeBotId
                    ? ` · ${bots.find((b) => b.id === step.assigneeBotId)?.name ?? step.assigneeBotId}`
                    : ''}
                  {step.attempts > 0 ? ` · ${t('planner.attempts', { count: String(step.attempts) })}` : ''}
                </span>
                {step.error && (
                  <div style={{ fontSize: 13, color: '#b91c1c' }}>{step.error}</div>
                )}
                {/* v0.98: manual step controls are local-only — a
                    coordinator plan's steps are driven by its run. */}
                {!selectedPlan.remote && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                    <select
                      value={step.assigneeBotId ?? ''}
                      onChange={(e) =>
                        stepAction((s) =>
                          assignUiStep(s, selectedPlan.id, step.id, e.target.value || null),
                        )
                      }
                      aria-label={t('planner.assignBot')}
                      disabled={step.status === 'running'}
                      data-testid="plan-step-assign"
                    >
                      <option value="">{t('planner.unassigned')}</option>
                      {bots.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                    </select>
                    {step.status === 'pending' && (
                      <button
                        className="btn secondary"
                        onClick={() => stepAction((s) => startUiStep(s, selectedPlan.id, step.id))}
                      >
                        {t('planner.start')}
                      </button>
                    )}
                    {step.status === 'running' && (
                      <>
                        <button
                          className="btn secondary"
                          onClick={() => stepAction((s) => completeUiStep(s, selectedPlan.id, step.id))}
                        >
                          {t('planner.complete')}
                        </button>
                        <button
                          className="btn secondary"
                          onClick={() =>
                            stepAction((s) => failUiStep(s, selectedPlan.id, step.id, t('planner.failedByUser')))
                          }
                        >
                          {t('planner.fail')}
                        </button>
                      </>
                    )}
                    {step.status === 'failed' && (
                      <button
                        className="btn secondary"
                        onClick={() => stepAction((s) => retryUiStep(s, selectedPlan.id, step.id))}
                      >
                        {t('planner.retry')}
                      </button>
                    )}
                    {(step.status === 'pending' || step.status === 'failed') && (
                      <button
                        className="btn secondary"
                        onClick={() => stepAction((s) => skipUiStep(s, selectedPlan.id, step.id))}
                      >
                        {t('planner.skip')}
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ol>

          {/* v0.98: adding steps is local-only — coordinator plans are
              edited by the run, not from this view. */}
          {!selectedPlan.remote && (
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <input
                value={newStepTitle}
                onChange={(e) => setNewStepTitle(e.target.value)}
                placeholder={t('planner.addStepPlaceholder')}
                aria-label={t('planner.addStepPlaceholder')}
                data-testid="plan-add-step-input"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newStepTitle.trim()) {
                    stepAction((s) => addUiStep(s, selectedPlan.id, newStepTitle));
                    setNewStepTitle('');
                  }
                }}
              />
              <button
                className="btn secondary"
                onClick={() => {
                  if (!newStepTitle.trim()) return;
                  stepAction((s) => addUiStep(s, selectedPlan.id, newStepTitle));
                  setNewStepTitle('');
                }}
                data-testid="plan-add-step"
              >
                {t('planner.addStep')}
              </button>
            </div>
          )}
        </div>
      )}

      {store.plans.length === 0 && (
        <p className="empty" style={{ marginTop: 20 }}>
          {t('planner.empty')}
        </p>
      )}
    </div>
  );
}
