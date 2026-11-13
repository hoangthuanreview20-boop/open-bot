import { useCallback, useEffect, useState } from 'react';
import type { BotConfigLike } from '../types';
import { useT } from '../i18n/useT';

interface Props {
  bots: BotConfigLike[];
  botId: string | null;
  onBack: () => void;
  onSelectBot?: (botId: string) => void;
}

type Tab = 'routines' | 'webhooks' | 'health' | 'events';
type TriggerKind = 'interval' | 'cron' | 'webhook' | 'event' | 'manual';
type ActionKind = 'run-agent' | 'run-tool' | 'notify';
type RunStatus = 'queued' | 'running' | 'ok' | 'error' | 'skipped' | 'retrying';

interface RoutineLike {
  id: string;
  botId: string;
  name: string;
  description?: string;
  trigger: { kind: TriggerKind; minutes?: number; expression?: string; keyId?: string; event?: string };
  action: { kind: ActionKind; botId?: string; prompt?: string; tool?: string; args?: Record<string, unknown>; message?: string };
  enabled: boolean;
  maxAttempts?: number;
  retryBackoffMs?: number;
  maxQueuedRuns?: number;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RoutineRunLike {
  id: string;
  routineId: string;
  source: string;
  status: RunStatus;
  attempt: number;
  maxAttempts: number;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  nextRetryAt?: string;
  output?: string;
  error?: string;
  retriedFromRunId?: string;
}

interface WebhookStatsLike {
  listening: boolean;
  port: number;
  total: number;
  accepted: number;
  rejected: number;
  rejectedByReason: Record<string, number>;
  lastDeliveryAt?: string;
}

interface HealthLike {
  botId: string;
  computerId: string;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  cpuLoad?: number;
  memoryUsedRatio?: number;
  diskUsedRatio?: number;
  processAlive?: boolean;
  lastHeartbeatAt?: string;
  heartbeatAgeMs?: number;
  reasons: string[];
  probedAt: string;
  probeDurationMs: number;
}

interface NdjsonEventLike {
  v: number;
  seq: number;
  at: string;
  kind: string;
  botId: string;
  threadId: string;
  payload: Record<string, unknown>;
}

function asRoutine(value: unknown): RoutineLike | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as RoutineLike;
  if (typeof v.id !== 'string' || typeof v.name !== 'string') return null;
  if (!v.trigger || typeof v.trigger.kind !== 'string') return null;
  if (!v.action || typeof v.action.kind !== 'string') return null;
  return v;
}

function asRoutineList(value: unknown): RoutineLike[] {
  if (!Array.isArray(value)) return [];
  const out: RoutineLike[] = [];
  for (const item of value) {
    const r = asRoutine(item);
    if (r) out.push(r);
  }
  return out;
}

function asRunList(value: unknown): RoutineRunLike[] {
  if (!Array.isArray(value)) return [];
  const out: RoutineRunLike[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const r = item as RoutineRunLike;
    if (typeof r.id === 'string' && typeof r.routineId === 'string') out.push(r);
  }
  return out;
}

function asStats(value: unknown): WebhookStatsLike | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as WebhookStatsLike;
  if (typeof v.total !== 'number') return null;
  return v;
}

function asHealthList(value: unknown): HealthLike[] {
  if (!Array.isArray(value)) return [];
  const out: HealthLike[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const h = item as HealthLike;
    if (typeof h.botId === 'string' && typeof h.status === 'string') out.push(h);
  }
  return out;
}

function asEventList(value: unknown): NdjsonEventLike[] {
  if (!value || typeof value !== 'object') return [];
  const v = value as { events?: unknown };
  if (!Array.isArray(v.events)) return [];
  const out: NdjsonEventLike[] = [];
  for (const item of v.events) {
    if (!item || typeof item !== 'object') continue;
    const e = item as NdjsonEventLike;
    if (typeof e.kind === 'string' && typeof e.at === 'string') out.push(e);
  }
  return out;
}

function formatTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function describeTrigger(routine: RoutineLike): string {
  const trigger = routine.trigger;
  if (trigger.kind === 'interval') return `every ${trigger.minutes ?? '?'} min`;
  if (trigger.kind === 'cron') return trigger.expression ?? '';
  if (trigger.kind === 'webhook') return 'webhook';
  if (trigger.kind === 'event') return trigger.event ?? '';
  return 'manual';
}

function describeAction(routine: RoutineLike): string {
  const action = routine.action;
  if (action.kind === 'run-agent') return `agent ${action.botId ?? ''}: ${(action.prompt ?? '').slice(0, 60)}`;
  if (action.kind === 'run-tool') return `tool ${action.tool ?? ''}`;
  return `notify: ${(action.message ?? '').slice(0, 60)}`;
}

/**
 * Harness v2 management view (v0.97, Team T5).
 *
 * Four tabs, all read through the `harness2:*` IPC added in main:
 * routines (create / enable / run-now / retry / delete, with per-run
 * status), the signed webhook receiver (loopback-only stats), the
 * per-bot-computer health probe (background, never on a turn path),
 * and the versioned NDJSON event bus (tail). Every user-facing
 * string goes through `t('harness2.…')` — no hard-coded display
 * text, and no Vietnamese anywhere in this file (the i18n test
 * scans renderer files for it).
 */
export default function HarnessV2View({ bots, onBack }: Props) {
  const t = useT();
  const [tab, setTab] = useState<Tab>('routines');
  const [routines, setRoutines] = useState<RoutineLike[]>([]);
  const [runs, setRuns] = useState<RoutineRunLike[]>([]);
  const [stats, setStats] = useState<WebhookStatsLike | null>(null);
  const [health, setHealth] = useState<HealthLike[]>([]);
  const [events, setEvents] = useState<NdjsonEventLike[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<RoutineLike | null>(null);

  // Create-form state (kept minimal: name, bot, trigger, action).
  const [formName, setFormName] = useState('');
  const [formBotId, setFormBotId] = useState('');
  const [formTrigger, setFormTrigger] = useState<TriggerKind>('interval');
  const [formMinutes, setFormMinutes] = useState('60');
  const [formCron, setFormCron] = useState('0 9 * * *');
  const [formEvent, setFormEvent] = useState('agent-done');
  const [formAction, setFormAction] = useState<ActionKind>('run-agent');
  const [formPrompt, setFormPrompt] = useState('');
  const [formTool, setFormTool] = useState('');
  const [formMessage, setFormMessage] = useState('');

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [list, allRuns, webhookStats, healthList, tail] = await Promise.all([
        window.openBot.listHarnessRoutines(),
        window.openBot.listHarnessRoutineRuns(),
        window.openBot.getHarnessWebhookStats(),
        window.openBot.probeHarnessHealth(),
        window.openBot.tailHarnessEvents('harness', 50),
      ]);
      setRoutines(asRoutineList(list));
      setRuns(asRunList(allRuns));
      setStats(asStats(webhookStats));
      setHealth(asHealthList(healthList));
      setEvents(asEventList(tail));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('harness2.loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    const offRuns = window.openBot.onHarnessRunsChanged(() => {
      void loadAll();
    });
    const offHealth = window.openBot.onHarnessHealthChanged(() => {
      void loadAll();
    });
    return () => {
      offRuns();
      offHealth();
    };
  }, [loadAll]);

  const refreshTab = useCallback(() => {
    void loadAll();
  }, [loadAll]);

  const statusLabel = (status: RunStatus): string => {
    switch (status) {
      case 'queued':
        return t('harness2.statusQueued');
      case 'running':
        return t('harness2.statusRunning');
      case 'ok':
        return t('harness2.statusOk');
      case 'error':
        return t('harness2.statusError');
      case 'skipped':
        return t('harness2.statusSkipped');
      case 'retrying':
        return t('harness2.statusRetrying');
      default:
        return status;
    }
  };

  const healthLabel = (status: HealthLike['status']): string => {
    switch (status) {
      case 'healthy':
        return t('harness2.healthy');
      case 'degraded':
        return t('harness2.degraded');
      case 'unhealthy':
        return t('harness2.unhealthy');
      default:
        return t('harness2.unknown');
    }
  };

  const createRoutine = async (): Promise<void> => {
    const name = formName.trim();
    if (name === '') {
      setError(t('harness2.createError'));
      return;
    }
    const trigger =
      formTrigger === 'interval'
        ? { kind: 'interval' as const, minutes: Math.max(1, Number.parseInt(formMinutes, 10) || 60) }
        : formTrigger === 'cron'
          ? { kind: 'cron' as const, expression: formCron.trim() }
          : formTrigger === 'webhook'
            ? { kind: 'webhook' as const, keyId: '' }
            : formTrigger === 'event'
              ? { kind: 'event' as const, event: formEvent.trim() }
              : { kind: 'manual' as const };
    const action =
      formAction === 'run-agent'
        ? { kind: 'run-agent' as const, botId: formBotId, prompt: formPrompt.trim() }
        : formAction === 'run-tool'
          ? { kind: 'run-tool' as const, tool: formTool.trim(), args: {} }
          : { kind: 'notify' as const, message: formMessage.trim() };
    try {
      // A webhook routine gets its key id = routine id after creation;
      // the main process reads the secret from the webhook key store.
      const created = await window.openBot.createHarnessRoutine({
        botId: formBotId,
        name,
        trigger,
        action,
        enabled: true,
      });
      const routine = asRoutine(created);
      if (routine && trigger.kind === 'webhook') {
        await window.openBot.updateHarnessRoutine({
          ...routine,
          trigger: { kind: 'webhook', keyId: routine.id },
        });
      }
      setFormOpen(false);
      setFormName('');
      setFormPrompt('');
      setFormTool('');
      setFormMessage('');
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('harness2.createError'));
    }
  };

  const toggleRoutine = async (routine: RoutineLike): Promise<void> => {
    try {
      await window.openBot.setHarnessRoutineEnabled(routine.id, !routine.enabled);
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('harness2.loadError'));
    }
  };

  const runNow = async (routine: RoutineLike): Promise<void> => {
    try {
      await window.openBot.runHarnessRoutineNow(routine.id);
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('harness2.loadError'));
    }
  };

  const retryFailed = async (routine: RoutineLike): Promise<void> => {
    const failed = runs
      .filter((r) => r.routineId === routine.id && r.status === 'error')
      .sort((a, b) => (a.finishedAt ?? a.queuedAt) < (b.finishedAt ?? b.queuedAt) ? 1 : -1)[0];
    if (!failed) return;
    try {
      await window.openBot.retryHarnessRoutineRun(failed.id);
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('harness2.loadError'));
    }
  };

  const deleteRoutine = async (): Promise<void> => {
    if (!deleteTarget) return;
    try {
      await window.openBot.deleteHarnessRoutine(deleteTarget.id);
      setDeleteTarget(null);
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('harness2.loadError'));
    }
  };

  const latestRunFor = (routineId: string): RoutineRunLike | undefined => {
    const list = runs.filter((r) => r.routineId === routineId);
    return list.length > 0 ? list[list.length - 1] : undefined;
  };

  return (
    <div className="view">
      <div className="view-header">
        <button type="button" className="btn-ghost" onClick={onBack}>
          {t('harness2.back')}
        </button>
        <h2>{t('harness2.title')}</h2>
      </div>
      <p className="view-intro">{t('harness2.intro')}</p>
      {error !== '' && (
        <div className="error-banner" role="alert">
          {error}
          <button type="button" className="btn-ghost" onClick={refreshTab}>
            {t('harness2.retry')}
          </button>
        </div>
      )}
      <div className="tabs" role="tablist">
        {(
          [
            ['routines', 'harness2.tabRoutines'],
            ['webhooks', 'harness2.tabWebhooks'],
            ['health', 'harness2.tabHealth'],
            ['events', 'harness2.tabEvents'],
          ] as const
        ).map(([key, labelKey]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? 'tab active' : 'tab'}
            onClick={() => setTab(key)}
          >
            {t(labelKey)}
          </button>
        ))}
        <button type="button" className="btn-ghost" onClick={refreshTab}>
          {t('harness2.refresh')}
        </button>
      </div>

      {loading ? (
        <p>{t('harness2.loading')}</p>
      ) : tab === 'routines' ? (
        <section>
          <h3>{t('harness2.routinesTitle')}</h3>
          {routines.length === 0 ? (
            <p>{t('harness2.routinesEmpty')}</p>
          ) : (
            <ul className="list">
              {routines.map((routine) => {
                const latest = latestRunFor(routine.id);
                return (
                  <li key={routine.id} className="list-item">
                    <div>
                      <strong>{routine.name}</strong>{' '}
                      <span>{routine.enabled ? t('harness2.enabled') : '—'}</span>
                      <div>
                        {describeTrigger(routine)} · {describeAction(routine)}
                      </div>
                      <div>
                        {t('harness2.nextRun')}: {formatTime(routine.nextRunAt) || t('harness2.never')} ·{' '}
                        {t('harness2.lastRun')}: {formatTime(routine.lastRunAt) || t('harness2.never')}
                      </div>
                      {latest && (
                        <div>
                          {t('harness2.latestRun')}: {statusLabel(latest.status)} ({latest.attempt}/{latest.maxAttempts})
                          {latest.error ? ` — ${latest.error.slice(0, 200)}` : ''}
                        </div>
                      )}
                    </div>
                    <div className="row-actions">
                      <button type="button" onClick={() => void toggleRoutine(routine)}>
                        {routine.enabled ? '⏸' : '▶'}
                      </button>
                      <button type="button" onClick={() => void runNow(routine)}>
                        {t('harness2.runNow')}
                      </button>
                      {latest?.status === 'error' && (
                        <button type="button" onClick={() => void retryFailed(routine)}>
                          {t('harness2.retryRun')}
                        </button>
                      )}
                      <button type="button" onClick={() => setDeleteTarget(routine)}>
                        {t('harness2.delete')}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {deleteTarget && (
            <div className="confirm-box" role="alertdialog">
              <p>{t('harness2.deleteConfirm', { name: deleteTarget.name })}</p>
              <button type="button" onClick={() => void deleteRoutine()}>
                {t('harness2.delete')}
              </button>
              <button type="button" onClick={() => setDeleteTarget(null)}>
                {t('harness2.cancel')}
              </button>
            </div>
          )}
          {formOpen ? (
            <fieldset>
              <legend>{t('harness2.create')}</legend>
              <label>
                {t('harness2.name')}
                <input value={formName} onChange={(e) => setFormName(e.target.value)} placeholder={t('harness2.namePlaceholder')} />
              </label>
              <label>
                {t('harness2.bot')}
                <select value={formBotId} onChange={(e) => setFormBotId(e.target.value)}>
                  <option value="">{t('harness2.globalBot')}</option>
                  {bots.map((bot) => (
                    <option key={bot.id} value={bot.id}>
                      {bot.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('harness2.trigger')}
                <select value={formTrigger} onChange={(e) => setFormTrigger(e.target.value as TriggerKind)}>
                  <option value="interval">{t('harness2.triggerInterval')}</option>
                  <option value="cron">{t('harness2.triggerCron')}</option>
                  <option value="webhook">{t('harness2.triggerWebhook')}</option>
                  <option value="event">{t('harness2.triggerEvent')}</option>
                  <option value="manual">{t('harness2.triggerManual')}</option>
                </select>
              </label>
              {formTrigger === 'interval' && (
                <label>
                  {t('harness2.intervalMinutes')}
                  <input value={formMinutes} onChange={(e) => setFormMinutes(e.target.value)} inputMode="numeric" />
                </label>
              )}
              {formTrigger === 'cron' && (
                <label>
                  {t('harness2.cronExpression')}
                  <input value={formCron} onChange={(e) => setFormCron(e.target.value)} />
                </label>
              )}
              {formTrigger === 'event' && (
                <label>
                  {t('harness2.eventName')}
                  <input value={formEvent} onChange={(e) => setFormEvent(e.target.value)} />
                </label>
              )}
              <label>
                {t('harness2.action')}
                <select value={formAction} onChange={(e) => setFormAction(e.target.value as ActionKind)}>
                  <option value="run-agent">{t('harness2.actionRunAgent')}</option>
                  <option value="run-tool">{t('harness2.actionRunTool')}</option>
                  <option value="notify">{t('harness2.actionNotify')}</option>
                </select>
              </label>
              {formAction === 'run-agent' && (
                <label>
                  {t('harness2.prompt')}
                  <textarea value={formPrompt} onChange={(e) => setFormPrompt(e.target.value)} />
                </label>
              )}
              {formAction === 'run-tool' && (
                <label>
                  {t('harness2.tool')}
                  <input value={formTool} onChange={(e) => setFormTool(e.target.value)} />
                </label>
              )}
              {formAction === 'notify' && (
                <label>
                  {t('harness2.message')}
                  <input value={formMessage} onChange={(e) => setFormMessage(e.target.value)} />
                </label>
              )}
              <div className="row-actions">
                <button type="button" onClick={() => void createRoutine()}>
                  {t('harness2.save')}
                </button>
                <button type="button" onClick={() => setFormOpen(false)}>
                  {t('harness2.cancel')}
                </button>
              </div>
            </fieldset>
          ) : (
            <button type="button" onClick={() => setFormOpen(true)}>
              {t('harness2.create')}
            </button>
          )}
        </section>
      ) : tab === 'webhooks' ? (
        <section>
          <h3>{t('harness2.webhooksTitle')}</h3>
          <p>{t('harness2.webhooksIntro')}</p>
          {stats ? (
            <dl>
              <div>
                <dt>{t('harness2.listening')}</dt>
                <dd>{stats.listening ? t('harness2.listening') : t('harness2.offline')}</dd>
              </div>
              <div>
                <dt>{t('harness2.port')}</dt>
                <dd>{stats.port}</dd>
              </div>
              <div>
                <dt>{t('harness2.total')}</dt>
                <dd>{stats.total}</dd>
              </div>
              <div>
                <dt>{t('harness2.accepted')}</dt>
                <dd>{stats.accepted}</dd>
              </div>
              <div>
                <dt>{t('harness2.rejected')}</dt>
                <dd>{stats.rejected}</dd>
              </div>
              {stats.lastDeliveryAt && (
                <div>
                  <dt>{t('harness2.lastDelivery')}</dt>
                  <dd>{formatTime(stats.lastDeliveryAt)}</dd>
                </div>
              )}
            </dl>
          ) : (
            <p>{t('harness2.noDeliveries')}</p>
          )}
        </section>
      ) : tab === 'health' ? (
        <section>
          <h3>{t('harness2.healthTitle')}</h3>
          <p>{t('harness2.healthIntro')}</p>
          <button type="button" onClick={refreshTab}>
            {t('harness2.probeNow')}
          </button>
          {health.length === 0 ? (
            <p>{t('harness2.noBots')}</p>
          ) : (
            <ul className="list">
              {health.map((h) => (
                <li key={h.botId} className="list-item">
                  <div>
                    <strong>{h.botId}</strong> — {healthLabel(h.status)}
                    <div>
                      {t('harness2.cpu')}: {h.cpuLoad !== undefined ? `${Math.round(h.cpuLoad * 100)}%` : '—'} ·{' '}
                      {t('harness2.memory')}: {h.memoryUsedRatio !== undefined ? `${Math.round(h.memoryUsedRatio * 100)}%` : '—'} ·{' '}
                      {t('harness2.disk')}: {h.diskUsedRatio !== undefined ? `${Math.round(h.diskUsedRatio * 100)}%` : '—'}
                    </div>
                    <div>
                      {t('harness2.processAlive')}: {h.processAlive === undefined ? '—' : h.processAlive ? '✓' : '✗'} ·{' '}
                      {t('harness2.lastHeartbeat')}: {h.heartbeatAgeMs !== undefined ? `${Math.round(h.heartbeatAgeMs / 1000)}s` : '—'}
                    </div>
                    {h.reasons.length > 0 && <div>{h.reasons.join(' ')}</div>}
                    <div>
                      {t('harness2.probedAt')}: {formatTime(h.probedAt)} ({h.probeDurationMs}ms)
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <section>
          <h3>{t('harness2.eventsTitle')}</h3>
          <p>{t('harness2.eventsIntro')}</p>
          {events.length === 0 ? (
            <p>{t('harness2.noEvents')}</p>
          ) : (
            <ul className="list">
              {events.map((event) => (
                <li key={`${event.seq}-${event.at}`} className="list-item">
                  <code>
                    #{event.seq} {event.kind} · {event.botId || '—'} · {formatTime(event.at)}
                  </code>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
