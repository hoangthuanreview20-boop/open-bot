import { useCallback, useEffect, useState } from 'react';
import type { FleetCapacityCheckView, FleetStatusView, FleetWorkspaceView } from '../types';
import { useT } from '../i18n/useT';

/**
 * Fleet workspaces (Team D) — minimal multi-user fleet layer.
 * One workspace per person: its own OS user, service, loopback port
 * and folder. Core stays single-user; the fleet layer sits on top.
 *
 * Data flows over IPC `fleet:*` (see main.ts). Shapes live in
 * ../types.ts (mirror of core packages/core/src/fleet/types.ts) —
 * IPC only returns plain JSON, never secrets. Services bind
 * 127.0.0.1 only (loopback-trust); health tokens never leave memory.
 */

/** Call a window.openBot method by IPC channel, falling back to camelCase. */
async function callOpenBot<T>(channel: string, camel: string, ...args: unknown[]): Promise<T | null> {
  const api = window.openBot as unknown as Record<string, unknown>;
  const fn = api[channel] ?? api[camel];
  if (typeof fn !== 'function') return null;
  return (fn as (...a: unknown[]) => Promise<T>).apply(window.openBot, args);
}

function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${mb.toFixed(0)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function formatUptime(ms: number | null): string {
  if (ms === null) return '—';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function stateLabel(t: (key: string, vars?: Record<string, string | number>) => string, state: string): string {
  if (state === 'running') return t('fleet.stateRunning');
  if (state === 'starting') return t('fleet.stateStarting');
  if (state === 'error') return t('fleet.stateError');
  return t('fleet.stateStopped');
}

interface Props {
  onBack: () => void;
}

export default function FleetView({ onBack }: Props) {
  const t = useT();
  const [fleet, setFleet] = useState<FleetStatusView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [auditLine, setAuditLine] = useState<string | null>(null);
  const [decisionsLine, setDecisionsLine] = useState<string | null>(null);
  const [capacity, setCapacity] = useState<FleetCapacityCheckView | null>(null);
  const [name, setName] = useState('');
  const [osUser, setOsUser] = useState('');
  const [cpuCores, setCpuCores] = useState('1');
  const [ramGb, setRamGb] = useState('1');
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [removeData, setRemoveData] = useState(false);

  const loadFleet = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await callOpenBot<FleetStatusView[]>('fleet:list', 'listFleet');
      if (list) setFleet(list);
      else setError(t('fleet.loadError'));
    } catch (err) {
      setError((err as Error).message || t('fleet.loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const loadAuditStatus = useCallback(async () => {
    try {
      const audit = await callOpenBot<{ ok: boolean; checked: number; badLine?: number; reason?: string }>(
        'fleet:audit-verify',
        'verifyFleetAudit',
      );
      if (audit) {
        setAuditLine(
          audit.ok
            ? t('fleet.auditOk', { count: audit.checked })
            : t('fleet.auditBad', { line: audit.badLine ?? 0, reason: audit.reason ?? t('fleet.unknown') }),
        );
      }
      const decisions = await callOpenBot<{ ok: boolean; checked: number; badLine?: number; reason?: string }>(
        'fleet:decisions-verify',
        'verifyFleetDecisions',
      );
      if (decisions) {
        setDecisionsLine(
          decisions.ok
            ? t('fleet.decisionsOk', { count: decisions.checked })
            : t('fleet.decisionsBad', { line: decisions.badLine ?? 0, reason: decisions.reason ?? t('fleet.unknown') }),
        );
      }
    } catch {
      // Audit status is best-effort; the list still works without it.
    }
  }, [t]);

  useEffect(() => {
    void loadFleet();
    void loadAuditStatus();
  }, [loadFleet, loadAuditStatus]);

  async function handleCheckCapacity() {
    setActionError(null);
    setCapacity(null);
    try {
      const cpu = Number.parseFloat(cpuCores);
      const ram = Number.parseFloat(ramGb);
      const result = await callOpenBot<FleetCapacityCheckView>('fleet:capacity', 'checkFleetCapacity', {
        cpuCores: Number.isFinite(cpu) && cpu > 0 ? cpu : 1,
        ramBytes: Number.isFinite(ram) && ram > 0 ? ram * 1024 ** 3 : 1024 ** 3,
        diskBytes: 10 * 1024 ** 3,
      });
      if (result) setCapacity(result);
    } catch (err) {
      setActionError((err as Error).message || t('fleet.actionError'));
    }
  }

  async function handleCreate() {
    if (name.trim() === '' || osUser.trim() === '') return;
    setBusyAction('create');
    setActionError(null);
    try {
      const cpu = Number.parseFloat(cpuCores);
      const ram = Number.parseFloat(ramGb);
      const created = await callOpenBot<FleetWorkspaceView>('fleet:create', 'createFleetWorkspace', {
        name: name.trim(),
        osUser: osUser.trim(),
        cpuCores: Number.isFinite(cpu) && cpu > 0 ? cpu : 1,
        ramBytes: Number.isFinite(ram) && ram > 0 ? ram * 1024 ** 3 : 1024 ** 3,
      });
      if (created) {
        setName('');
        setOsUser('');
        setCapacity(null);
        await loadFleet();
      }
    } catch (err) {
      setActionError((err as Error).message || t('fleet.actionError'));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleServiceAction(id: string, action: 'start' | 'stop' | 'restart') {
    setBusyAction(`${action}:${id}`);
    setActionError(null);
    try {
      const camel = action === 'start' ? 'startFleetService' : action === 'stop' ? 'stopFleetService' : 'restartFleetService';
      const updated = await callOpenBot<FleetStatusView>(`fleet:${action}`, camel, id);
      if (updated) {
        setFleet((prev) => prev.map((s) => (s.workspace.id === id ? updated : s)));
      }
    } catch (err) {
      setActionError((err as Error).message || t('fleet.actionError'));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleWorkspaceAction(id: string, action: 'suspend' | 'activate') {
    setBusyAction(`${action}:${id}`);
    setActionError(null);
    try {
      const camel = action === 'suspend' ? 'suspendFleetWorkspace' : 'activateFleetWorkspace';
      const updated = await callOpenBot<FleetWorkspaceView>(`fleet:${action}`, camel, id);
      if (updated) {
        setFleet((prev) =>
          prev.map((s) => (s.workspace.id === id ? { ...s, workspace: { ...s.workspace, ...updated } } : s)),
        );
      }
    } catch (err) {
      setActionError((err as Error).message || t('fleet.actionError'));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRemove(id: string) {
    setBusyAction(`remove:${id}`);
    setActionError(null);
    try {
      await callOpenBot<{ removed: boolean }>('fleet:remove', 'removeFleetWorkspace', { id, deleteData: removeData });
      setConfirmRemoveId(null);
      setRemoveData(false);
      await loadFleet();
    } catch (err) {
      setActionError((err as Error).message || t('fleet.actionError'));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRecordUsage(id: string) {
    setBusyAction(`usage:${id}`);
    setActionError(null);
    try {
      const updated = await callOpenBot<FleetStatusView>('fleet:record-usage', 'recordFleetUsage', id);
      if (updated) {
        setFleet((prev) => prev.map((s) => (s.workspace.id === id ? updated : s)));
      } else {
        await loadFleet();
      }
    } catch (err) {
      setActionError((err as Error).message || t('fleet.actionError'));
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div>
      <button type="button" onClick={onBack}>
        {t('fleet.back')}
      </button>
      <h2>{t('fleet.title')}</h2>
      <p>{t('fleet.description')}</p>

      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={() => void loadFleet()}>
            {t('fleet.refresh')}
          </button>
        </p>
      )}
      {actionError && <p role="alert">{actionError}</p>}
      {auditLine && <p>{auditLine}</p>}
      {decisionsLine && <p>{decisionsLine}</p>}

      <section>
        <h3>{t('fleet.createTitle')}</h3>
        <label>
          {t('fleet.nameLabel')}{' '}
          <input
            type="text"
            value={name}
            placeholder={t('fleet.namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
          />
        </label>{' '}
        <label>
          {t('fleet.osUserLabel')}{' '}
          <input
            type="text"
            value={osUser}
            placeholder={t('fleet.osUserPlaceholder')}
            onChange={(e) => setOsUser(e.target.value)}
          />
        </label>{' '}
        <label>
          {t('fleet.cpuLabel')}{' '}
          <input type="number" min="0.5" step="0.5" value={cpuCores} onChange={(e) => setCpuCores(e.target.value)} />
        </label>{' '}
        <label>
          {t('fleet.ramLabel')}{' '}
          <input type="number" min="0.5" step="0.5" value={ramGb} onChange={(e) => setRamGb(e.target.value)} />
        </label>{' '}
        <button type="button" onClick={() => void handleCheckCapacity()}>
          {t('fleet.capacityTitle')}
        </button>{' '}
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={busyAction === 'create' || name.trim() === '' || osUser.trim() === ''}
        >
          {busyAction === 'create' ? t('fleet.creating') : t('fleet.create')}
        </button>
        {capacity && (
          <p role="status">
            {capacity.ok
              ? t('fleet.capacityOk')
              : t('fleet.capacityDenied', { reason: capacity.reasonDetail ?? capacity.reason ?? t('fleet.unknown') })}
          </p>
        )}
      </section>

      <section>
        <h3>
          {t('fleet.title')}{' '}
          <button type="button" onClick={() => void loadFleet()} disabled={loading}>
            {t('fleet.refresh')}
          </button>
        </h3>
        {loading ? (
          <p>{t('fleet.refresh')}…</p>
        ) : fleet.length === 0 ? (
          <p>{t('fleet.empty')}</p>
        ) : (
          <ul>
            {fleet.map((entry) => {
              const ws = entry.workspace;
              const svc = entry.service;
              const usage = entry.usage;
              return (
                <li key={ws.id}>
                  <p>
                    <strong>{ws.name}</strong> — {ws.status === 'active' ? t('fleet.statusActive') : t('fleet.statusSuspended')}
                    {' · '}
                    {t('fleet.service')}: {stateLabel(t, svc.state)}
                    {svc.pid !== undefined ? ` (${t('fleet.pid')} ${svc.pid})` : ''}
                    {svc.uptimeMs !== null ? ` · ${t('fleet.uptime')}: ${formatUptime(svc.uptimeMs)}` : ''}
                  </p>
                  <p>
                    {t('fleet.osUser')}: {ws.osUser} · {t('fleet.port')}: {ws.port} ·{' '}
                    {t('fleet.isolation')}:{' '}
                    {ws.isolationLevel === 'os-user' ? t('fleet.isolationOsUser') : t('fleet.isolationDirectory')}
                    {ws.isolationReason ? ` (${ws.isolationReason})` : ''}
                  </p>
                  <p>
                    {t('fleet.allocated')}: {t('fleet.cpu')} {ws.cpuCores} · {t('fleet.ram')} {formatBytes(ws.ramBytes)} ·{' '}
                    {t('fleet.disk')} {formatBytes(ws.diskBytes)}
                  </p>
                  <p>
                    {t('fleet.usage')}:{' '}
                    {usage
                      ? `${t('fleet.ram')} ${usage.rssBytesLatest !== null ? formatBytes(usage.rssBytesLatest) : '—'} · ${t('fleet.disk')} ${usage.diskBytesLatest !== null ? formatBytes(usage.diskBytesLatest) : '—'}`
                      : '—'}{' '}
                    <button
                      type="button"
                      onClick={() => void handleRecordUsage(ws.id)}
                      disabled={busyAction === `usage:${ws.id}`}
                    >
                      {t('fleet.recordUsage')}
                    </button>
                  </p>
                  <p>
                    {t('fleet.members')}:{' '}
                    {ws.members.length === 0
                      ? t('fleet.noMembers')
                      : ws.members.map((m) => `${m.userId} (${m.role})`).join(', ')}
                  </p>
                  {svc.lastError && (
                    <p role="alert">
                      {svc.lastError}
                    </p>
                  )}
                  <p>
                    <button
                      type="button"
                      onClick={() => void handleServiceAction(ws.id, 'start')}
                      disabled={busyAction === `start:${ws.id}` || ws.status !== 'active' || svc.state === 'running'}
                    >
                      {t('fleet.start')}
                    </button>{' '}
                    <button
                      type="button"
                      onClick={() => void handleServiceAction(ws.id, 'stop')}
                      disabled={busyAction === `stop:${ws.id}` || svc.state !== 'running'}
                    >
                      {t('fleet.stop')}
                    </button>{' '}
                    <button
                      type="button"
                      onClick={() => void handleServiceAction(ws.id, 'restart')}
                      disabled={busyAction === `restart:${ws.id}` || ws.status !== 'active'}
                    >
                      {t('fleet.restart')}
                    </button>{' '}
                    {ws.status === 'active' ? (
                      <button
                        type="button"
                        onClick={() => void handleWorkspaceAction(ws.id, 'suspend')}
                        disabled={busyAction === `suspend:${ws.id}`}
                      >
                        {t('fleet.suspend')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleWorkspaceAction(ws.id, 'activate')}
                        disabled={busyAction === `activate:${ws.id}`}
                      >
                        {t('fleet.activate')}
                      </button>
                    )}{' '}
                    {confirmRemoveId === ws.id ? (
                      <span>
                        {t('fleet.removeConfirm', { name: ws.name })}{' '}
                        <label>
                          <input
                            type="checkbox"
                            checked={removeData}
                            onChange={(e) => setRemoveData(e.target.checked)}
                          />{' '}
                          {t('fleet.removeData')}
                        </label>{' '}
                        <button
                          type="button"
                          onClick={() => void handleRemove(ws.id)}
                          disabled={busyAction === `remove:${ws.id}`}
                        >
                          {t('fleet.confirmRemove')}
                        </button>{' '}
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmRemoveId(null);
                            setRemoveData(false);
                          }}
                        >
                          {t('fleet.cancel')}
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmRemoveId(ws.id)}
                        disabled={svc.state === 'running'}
                      >
                        {t('fleet.remove')}
                      </button>
                    )}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
