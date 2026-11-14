import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  BotQuotaView,
  FleetBotOverviewView,
  FleetConsoleOverviewView,
  FleetConsoleRoleView,
  FleetConsoleUserView,
} from '../types';
import { useT } from '../i18n/useT';

/**
 * Fleet console v2 — one place for the whole fleet: per-bot status and
 * usage, the fleet-wide user directory (admin / operator / viewer),
 * and per-bot resource quotas with warnings.
 *
 * Data flows over IPC `fleet:console-*` and `fleet:quotas-*` (see
 * main.ts). Shapes live in ../types.ts (mirror of core
 * packages/core/src/fleet/console.ts and quotas.ts) — IPC only returns
 * plain JSON, never secrets. Services bind 127.0.0.1 only.
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

function roleLabel(t: (key: string, vars?: Record<string, string | number>) => string, role: string): string {
  if (role === 'admin') return t('fleetConsole.roleAdmin');
  if (role === 'operator') return t('fleetConsole.roleOperator');
  return t('fleetConsole.roleViewer');
}

function resourceLabel(t: (key: string, vars?: Record<string, string | number>) => string, resource: string): string {
  if (resource === 'cpu') return t('fleet.cpu');
  if (resource === 'ram') return t('fleet.ram');
  return t('fleet.disk');
}

function usageBar(percent: number | null): ReactNode {
  if (percent === null) return null;
  const width = `${Math.min(100, Math.max(0, percent * 100)).toFixed(0)}%`;
  const color = percent >= 1 ? '#d33' : percent >= 0.8 ? '#c80' : '#4a4';
  return (
    <div style={{ height: 6, borderRadius: 3, background: '#ddd', overflow: 'hidden', marginTop: 4 }}>
      <div style={{ width, height: '100%', background: color }} />
    </div>
  );
}

type Tab = 'bots' | 'users' | 'quotas';

interface Props {
  onBack: () => void;
}

const MB = 1024 ** 2;
const GB = 1024 ** 3;

export default function FleetConsoleView({ onBack }: Props) {
  const t = useT();
  const [tab, setTab] = useState<Tab>('bots');
  const [overview, setOverview] = useState<FleetConsoleOverviewView | null>(null);
  const [users, setUsers] = useState<FleetConsoleUserView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemoveUserId, setConfirmRemoveUserId] = useState<string | null>(null);
  const [newUserId, setNewUserId] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newRole, setNewRole] = useState<FleetConsoleRoleView>('viewer');
  const [quotaBotId, setQuotaBotId] = useState('');
  const [quotaCpu, setQuotaCpu] = useState('1');
  const [quotaRamMb, setQuotaRamMb] = useState('1024');
  const [quotaDiskGb, setQuotaDiskGb] = useState('10');
  const [quotaWarn, setQuotaWarn] = useState('80');
  const [quotaEnabled, setQuotaEnabled] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ov, us] = await Promise.all([
        callOpenBot<FleetConsoleOverviewView>('fleet:console-overview', 'getFleetConsoleOverview'),
        callOpenBot<FleetConsoleUserView[]>('fleet:console-users', 'listFleetConsoleUsers'),
      ]);
      if (!ov || !us) {
        setError(t('fleetConsole.loadError'));
        return;
      }
      setOverview(ov);
      setUsers(us);
    } catch (err) {
      setError((err as Error).message || t('fleetConsole.loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const bots = overview?.bots ?? [];
  const alerts = overview?.alerts ?? [];
  const quotas = overview?.quotas ?? [];
  const selectedQuotaBotId = quotaBotId || bots[0]?.workspaceId || '';
  const selectedQuota = quotas.find((q) => q.botId === selectedQuotaBotId);

  // Prefill the quota form from the selected bot's quota (or defaults).
  useEffect(() => {
    if (!selectedQuotaBotId) return;
    if (selectedQuota) {
      setQuotaCpu(String(selectedQuota.cpuCoresMax));
      setQuotaRamMb(String(Math.round(selectedQuota.ramBytesMax / MB)));
      setQuotaDiskGb(String(Math.round(selectedQuota.diskBytesMax / GB)));
      setQuotaWarn(String(Math.round(selectedQuota.warnPercent * 100)));
      setQuotaEnabled(selectedQuota.enabled);
    } else {
      setQuotaCpu('1');
      setQuotaRamMb('1024');
      setQuotaDiskGb('10');
      setQuotaWarn('80');
      setQuotaEnabled(true);
    }
  }, [selectedQuotaBotId, selectedQuota]);

  async function handleAddUser() {
    if (!newUserId.trim()) return;
    setActionError(null);
    setNotice(null);
    setBusy(true);
    try {
      const user = await callOpenBot<FleetConsoleUserView>('fleet:console-add-user', 'addFleetConsoleUser', {
        userId: newUserId.trim(),
        displayName: newDisplayName.trim() || undefined,
        role: newRole,
      });
      if (!user) throw new Error(t('fleetConsole.addUserError'));
      setUsers((prev) => [...prev, user].sort((a, b) => a.userId.localeCompare(b.userId)));
      setNewUserId('');
      setNewDisplayName('');
      setNewRole('viewer');
    } catch (err) {
      setActionError((err as Error).message || t('fleetConsole.addUserError'));
    } finally {
      setBusy(false);
    }
  }

  async function handleSetRole(userId: string, role: FleetConsoleRoleView) {
    setActionError(null);
    setNotice(null);
    try {
      const updated = await callOpenBot<FleetConsoleUserView>('fleet:console-set-role', 'setFleetConsoleRole', {
        userId,
        role,
      });
      if (!updated) throw new Error(t('fleetConsole.addUserError'));
      setUsers((prev) => prev.map((u) => (u.userId === userId ? updated : u)));
    } catch (err) {
      setActionError((err as Error).message || t('fleetConsole.addUserError'));
    }
  }

  async function handleRemoveUser(userId: string) {
    setActionError(null);
    setNotice(null);
    setBusy(true);
    try {
      const result = await callOpenBot<{ removed: boolean }>(
        'fleet:console-remove-user',
        'removeFleetConsoleUser',
        userId,
      );
      if (!result?.removed) throw new Error(t('fleetConsole.addUserError'));
      setUsers((prev) => prev.filter((u) => u.userId !== userId));
      setConfirmRemoveUserId(null);
    } catch (err) {
      setActionError((err as Error).message || t('fleetConsole.addUserError'));
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveQuota() {
    if (!selectedQuotaBotId) return;
    setActionError(null);
    setNotice(null);
    const cpu = Number(quotaCpu);
    const ramMb = Number(quotaRamMb);
    const diskGb = Number(quotaDiskGb);
    const warn = Number(quotaWarn);
    if (!Number.isFinite(cpu) || cpu <= 0 || !Number.isFinite(ramMb) || ramMb <= 0 || !Number.isFinite(diskGb) || diskGb <= 0 || !Number.isFinite(warn) || warn <= 0 || warn >= 100) {
      setActionError(t('fleetConsole.quotaError'));
      return;
    }
    setBusy(true);
    try {
      const saved = await callOpenBot<BotQuotaView>('fleet:quotas-set', 'setBotQuota', {
        botId: selectedQuotaBotId,
        cpuCoresMax: cpu,
        ramBytesMax: Math.round(ramMb * MB),
        diskBytesMax: Math.round(diskGb * GB),
        warnPercent: warn / 100,
        enabled: quotaEnabled,
      });
      if (!saved) throw new Error(t('fleetConsole.quotaError'));
      setNotice(t('fleetConsole.quotaSaved'));
      await load();
    } catch (err) {
      setActionError((err as Error).message || t('fleetConsole.quotaError'));
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveQuota(botId: string) {
    setActionError(null);
    setNotice(null);
    setBusy(true);
    try {
      await callOpenBot<{ removed: boolean }>('fleet:quotas-remove', 'removeBotQuota', botId);
      setNotice(t('fleetConsole.quotaRemoved'));
      await load();
    } catch (err) {
      setActionError((err as Error).message || t('fleetConsole.quotaError'));
    } finally {
      setBusy(false);
    }
  }

  function botName(botId: string): string {
    return bots.find((b) => b.workspaceId === botId)?.name ?? botId;
  }

  return (
    <div>
      <div className="row" style={{ alignItems: 'center', gap: 8 }}>
        <button className="btn secondary" onClick={onBack}>
          {t('fleet.back')}
        </button>
        <h2 style={{ margin: 0, flex: 1 }}>{t('fleetConsole.title')}</h2>
        <button className="btn secondary" onClick={() => void load()} disabled={loading}>
          {t('fleet.refresh')}
        </button>
      </div>
      <p style={{ color: '#666', marginTop: 4 }}>{t('fleetConsole.subtitle')}</p>

      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <button className={tab === 'bots' ? 'btn' : 'btn secondary'} onClick={() => setTab('bots')}>
          {t('fleetConsole.tabBots')}
        </button>
        <button className={tab === 'users' ? 'btn' : 'btn secondary'} onClick={() => setTab('users')}>
          {t('fleetConsole.tabUsers')}
        </button>
        <button className={tab === 'quotas' ? 'btn' : 'btn secondary'} onClick={() => setTab('quotas')}>
          {t('fleetConsole.tabQuotas')}
          {alerts.length > 0 ? ` (${alerts.length})` : ''}
        </button>
      </div>

      {loading && <p>{t('marketplace.loading')}</p>}
      {error && <p style={{ color: '#c00' }}>{error}</p>}
      {notice && <p style={{ color: '#080' }}>{notice}</p>}
      {actionError && <p style={{ color: '#c00' }}>{actionError}</p>}

      {!loading && !error && tab === 'bots' && (
        <div>
          {bots.length === 0 && <p>{t('fleetConsole.noBots')}</p>}
          {bots.map((bot: FleetBotOverviewView) => (
            <div key={bot.workspaceId} style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, marginBottom: 10 }}>
              <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                <strong>{bot.name}</strong>
                <span>
                  {stateLabel(t, bot.state)} · {t('fleet.uptime')}: {formatUptime(bot.uptimeMs)}
                </span>
              </div>
              <div style={{ color: '#666', fontSize: 13 }}>
                {t('fleet.osUser')}: {bot.osUser} · {t('fleet.cpu')}: {bot.cpuCores} · {t('fleet.members')}:{' '}
                {bot.members.length}
              </div>
              <div style={{ marginTop: 8 }}>
                <div>
                  {t('fleet.ram')}:{' '}
                  {bot.ramUsedBytes === null
                    ? t('fleetConsole.unmeasured')
                    : t('fleetConsole.usedOf', { used: formatBytes(bot.ramUsedBytes), limit: formatBytes(bot.ramBytes) })}
                </div>
                {usageBar(bot.ramUsedPercent)}
              </div>
              <div style={{ marginTop: 8 }}>
                <div>
                  {t('fleet.disk')}:{' '}
                  {bot.diskUsedBytes === null
                    ? t('fleetConsole.unmeasured')
                    : t('fleetConsole.usedOf', { used: formatBytes(bot.diskUsedBytes), limit: formatBytes(bot.diskBytes) })}
                </div>
                {usageBar(bot.diskUsedPercent)}
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && !error && tab === 'users' && (
        <div>
          {users.length === 0 && <p>{t('fleetConsole.noUsers')}</p>}
          {users.map((user) => (
            <div key={user.userId} style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, marginBottom: 10 }}>
              <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <div>
                  <strong>{user.displayName}</strong>{' '}
                  <span style={{ color: '#666' }}>({user.userId})</span>
                </div>
                <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <label>
                    {t('fleetConsole.role')}{' '}
                    <select
                      value={user.role}
                      disabled={busy}
                      onChange={(e) => void handleSetRole(user.userId, e.target.value as FleetConsoleRoleView)}
                    >
                      <option value="admin">{t('fleetConsole.roleAdmin')}</option>
                      <option value="operator">{t('fleetConsole.roleOperator')}</option>
                      <option value="viewer">{t('fleetConsole.roleViewer')}</option>
                    </select>
                  </label>
                  {confirmRemoveUserId === user.userId ? (
                    <>
                      <button className="btn" disabled={busy} onClick={() => void handleRemoveUser(user.userId)}>
                        {t('fleet.remove')}
                      </button>
                      <button className="btn secondary" onClick={() => setConfirmRemoveUserId(null)}>
                        {t('fleet.cancel')}
                      </button>
                    </>
                  ) : (
                    <button className="btn secondary" disabled={busy} onClick={() => setConfirmRemoveUserId(user.userId)}>
                      {t('fleet.remove')}
                    </button>
                  )}
                </div>
              </div>
              <div style={{ color: '#666', fontSize: 13, marginTop: 4 }}>
                {t('fleetConsole.workspaces')}: {user.workspaceIds.length > 0 ? user.workspaceIds.join(', ') : '—'}
              </div>
            </div>
          ))}
          <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, marginTop: 12 }}>
            <strong>{t('fleetConsole.addUser')}</strong>
            <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <input
                value={newUserId}
                onChange={(e) => setNewUserId(e.target.value)}
                placeholder={t('fleetConsole.userIdPlaceholder')}
                disabled={busy}
              />
              <input
                value={newDisplayName}
                onChange={(e) => setNewDisplayName(e.target.value)}
                placeholder={t('fleetConsole.displayNamePlaceholder')}
                disabled={busy}
              />
              <select value={newRole} disabled={busy} onChange={(e) => setNewRole(e.target.value as FleetConsoleRoleView)}>
                <option value="admin">{t('fleetConsole.roleAdmin')}</option>
                <option value="operator">{t('fleetConsole.roleOperator')}</option>
                <option value="viewer">{t('fleetConsole.roleViewer')}</option>
              </select>
              <button className="btn" disabled={busy || !newUserId.trim()} onClick={() => void handleAddUser()}>
                {t('fleetConsole.addUser')}
              </button>
            </div>
          </div>
        </div>
      )}

      {!loading && !error && tab === 'quotas' && (
        <div>
          <h3 style={{ marginTop: 0 }}>{t('fleetConsole.alerts')}</h3>
          {alerts.length === 0 && <p>{t('fleetConsole.noAlerts')}</p>}
          {alerts.map((alert, i) => (
            <p key={`${alert.botId}:${alert.resource}:${i}`} style={{ color: alert.level === 'breach' ? '#c00' : '#c80' }}>
              <strong>{botName(alert.botId)}</strong> · {resourceLabel(t, alert.resource)} ·{' '}
              {alert.level === 'breach' ? t('fleetConsole.alertBreach') : t('fleetConsole.alertWarning')} ·{' '}
              {t('fleetConsole.usedOf', { used: formatBytes(alert.used), limit: formatBytes(alert.limit) })} (
              {Math.round(alert.percent * 100)}%)
            </p>
          ))}

          <h3>{t('fleetConsole.tabQuotas')}</h3>
          {bots.length === 0 && <p>{t('fleetConsole.noBots')}</p>}
          {bots.length > 0 && (
            <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12 }}>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <label>
                  {t('fleetConsole.selectBot')}{' '}
                  <select value={selectedQuotaBotId} onChange={(e) => setQuotaBotId(e.target.value)}>
                    {bots.map((bot) => (
                      <option key={bot.workspaceId} value={bot.workspaceId}>
                        {bot.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <input type="checkbox" checked={quotaEnabled} onChange={(e) => setQuotaEnabled(e.target.checked)} />{' '}
                  {t('fleetConsole.quotaEnabled')}
                </label>
              </div>
              <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <label>
                  {t('fleetConsole.quotaCpu')}{' '}
                  <input value={quotaCpu} onChange={(e) => setQuotaCpu(e.target.value)} style={{ width: 70 }} disabled={busy} />
                </label>
                <label>
                  {t('fleetConsole.quotaRam')}{' '}
                  <input value={quotaRamMb} onChange={(e) => setQuotaRamMb(e.target.value)} style={{ width: 90 }} disabled={busy} />
                </label>
                <label>
                  {t('fleetConsole.quotaDisk')}{' '}
                  <input value={quotaDiskGb} onChange={(e) => setQuotaDiskGb(e.target.value)} style={{ width: 70 }} disabled={busy} />
                </label>
                <label>
                  {t('fleetConsole.quotaWarn')}{' '}
                  <input value={quotaWarn} onChange={(e) => setQuotaWarn(e.target.value)} style={{ width: 60 }} disabled={busy} />
                </label>
              </div>
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <button className="btn" disabled={busy || !selectedQuotaBotId} onClick={() => void handleSaveQuota()}>
                  {t('fleetConsole.saveQuota')}
                </button>
                {selectedQuota && (
                  <button className="btn secondary" disabled={busy} onClick={() => void handleRemoveQuota(selectedQuota.botId)}>
                    {t('fleetConsole.removeQuota')}
                  </button>
                )}
              </div>
              {quotas.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  {quotas.map((q) => (
                    <div key={q.botId} style={{ fontSize: 13, color: '#555' }}>
                      {t('fleetConsole.quotaFor', { name: botName(q.botId) })}: {q.cpuCoresMax} CPU ·{' '}
                      {formatBytes(q.ramBytesMax)} RAM · {formatBytes(q.diskBytesMax)} {t('fleet.disk')} ·{' '}
                      {t('fleetConsole.quotaWarn')} {Math.round(q.warnPercent * 100)}% ·{' '}
                      {q.enabled ? t('pluginMarketplace.enabled') : t('plugin.disabled')}
                    </div>
                  ))}
                </div>
              )}
              {quotas.length === 0 && <p style={{ marginBottom: 0 }}>{t('fleetConsole.noQuotas')}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
