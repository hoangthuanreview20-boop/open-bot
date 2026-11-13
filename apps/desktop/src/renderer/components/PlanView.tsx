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
 */
import { useEffect, useMemo, useState } from 'react';
import type { BotConfigLike } from '../types';
import { useT } from '../i18n/useT';
import {
  PLAN_STORE_KEY,
  addUiPlan,
  addUiStep,
  assignUiStep,
  checkUiPlanStuck,
  completeUiStep,
  createUiPlan,
  deleteUiPlan,
  dispatchUiStep,
  emptyPlanStore,
  failUiStep,
  parsePlanStore,
  planProgressOf,
  retryUiStep,
  skipUiStep,
  startUiStep,
  stringifyPlanStore,
  type PlanStore,
  type UiPlan,
  type UiPlanStep,
  type UiStuckReport,
} from './planStore';

interface Props {
  bots: BotConfigLike[];
  onBack: () => void;
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

export default function PlanView({ bots, onBack }: Props) {
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

  useEffect(() => {
    try {
      safeLocalStorage()?.setItem(PLAN_STORE_KEY, stringifyPlanStore(store));
    } catch {
      // Storage unavailable — the plans still work for this session.
    }
  }, [store]);

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
              onClick={() => {
                update(deleteUiPlan(store, selectedPlan.id));
                setSelectedPlanId(null);
              }}
            >
              {t('planner.delete')}
            </button>
          </div>
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

          {stuck && (
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
              <div>{stuck.reason === 'repeated-tool-call' ? t('planner.stuckRepeated') : t('planner.stuckNoProgress')}</div>
              <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>{stuck.detail}</div>
              <div style={{ fontSize: 13, marginTop: 4 }}>
                {t('planner.stuckSuggestions')}: {stuck.suggestions.map((s) => t(`planner.suggestion.${s}`)).join(' · ')}
              </div>
            </div>
          )}

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
              </li>
            ))}
          </ol>

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
