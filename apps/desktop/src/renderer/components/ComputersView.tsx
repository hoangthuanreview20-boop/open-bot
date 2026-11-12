import { useCallback, useEffect, useRef, useState } from 'react';
import type { BotConfigLike, ComputerPlanView, ComputerQueueView, ComputerStatusView, ComputersProbeView, GuestAgentHealthView } from '../types';
import { useT } from '../i18n/useT';

/**
 * One computer per bot (Team B, platform wave) — screen showing the
 * probed machine, how resources are split per bot, and the status of
 * each bot-computer (running/paused, allocated CPU/RAM/disk + measured
 * disk in use).
 *
 * Data flows over IPC `computers:*` (see main.ts). Shapes live in
 * ../types.ts (mirror of core packages/core/src/compute/types.ts) —
 * IPC only returns plain JSON, never secrets.
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

function levelLabel(t: (key: string, vars?: Record<string, string | number>) => string, level: string): string {
  if (level === 'vm') return t('computers.levelVm');
  if (level === 'container') return t('computers.levelContainer');
  return t('computers.levelBox');
}

function stateLabel(t: (key: string, vars?: Record<string, string | number>) => string, state: string): string {
  if (state === 'running') return t('computers.stateRunning');
  if (state === 'paused') return t('computers.statePaused');
  if (state === 'error') return t('computers.stateError');
  return t('computers.stateStopped');
}

/** Guest health label (v0.90c): ok / missing / unhealthy / unknown. */
function guestHealthLabel(
  t: (key: string, vars?: Record<string, string | number>) => string,
  health: GuestAgentHealthView | undefined,
): string {
  if (!health) return t('computers.guestUnknown');
  if (health.status === 'ok') return t('computers.guestOk');
  if (health.status === 'missing') return t('computers.guestMissing');
  if (health.status === 'unhealthy') return t('computers.guestUnhealthy');
  return t('computers.guestUnknown');
}

/**
 * v0.90c: live refresh — list every 5s, probe every 30s (the main
 * process caches the probe for 30s, so the probe poll is cheap).
 */
const COMPUTERS_POLL_MS = 5000;
const PROBE_POLL_MS = 30000;

/** Same JSON string => same data: skip the state update (no useless re-render). */
function sameJson(prev: unknown, next: unknown): boolean {
  return JSON.stringify(prev) === JSON.stringify(next);
}

interface Props {
  bots: BotConfigLike[];
  onBack: () => void;
}

export default function ComputersView({ bots, onBack }: Props) {
  const t = useT();
  const [probe, setProbe] = useState<ComputersProbeView | null>(null);
  const [probeLoading, setProbeLoading] = useState(true);
  const [plan, setPlan] = useState<ComputerPlanView | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [computers, setComputers] = useState<ComputerStatusView[]>([]);
  const [computersLoading, setComputersLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [vmImageInputs, setVmImageInputs] = useState<Record<string, string>>({});
  const [shedMessage, setShedMessage] = useState<string | null>(null);
  // v0.90c: scheduler queue + auto-shed opt-in + priority drafts.
  const [queue, setQueue] = useState<ComputerQueueView | null>(null);
  const [priorityInputs, setPriorityInputs] = useState<Record<string, string>>({});
  // Guards overlapping polls (a slow IPC reply must not pile up).
  const listInFlight = useRef(false);
  const probeInFlight = useRef(false);

  const botName = useCallback(
    (botId: string): string => bots.find((b) => b.id === botId)?.name ?? botId,
    [bots],
  );

  const loadProbe = useCallback(async (quiet = false) => {
    if (!quiet) setProbeLoading(true);
    if (probeInFlight.current) return;
    probeInFlight.current = true;
    setError(null);
    try {
      const data = await callOpenBot<ComputersProbeView>('computers:probe', 'probeComputers');
      if (data) setProbe((prev) => (sameJson(prev, data) ? prev : data));
      else if (!quiet) setError(t('computers.loadError'));
    } catch (err) {
      if (!quiet) setError((err as Error).message || t('computers.loadError'));
    } finally {
      probeInFlight.current = false;
      if (!quiet) setProbeLoading(false);
    }
  }, [t]);

  const loadComputers = useCallback(async (quiet = false) => {
    if (!quiet) setComputersLoading(true);
    if (listInFlight.current) return;
    listInFlight.current = true;
    try {
      const list = await callOpenBot<ComputerStatusView[]>('computers:list', 'listComputers');
      if (list) setComputers((prev) => (sameJson(prev, list) ? prev : list));
    } catch (err) {
      if (!quiet) setActionError((err as Error).message || t('computers.actionError'));
    } finally {
      listInFlight.current = false;
      if (!quiet) setComputersLoading(false);
    }
  }, [t]);

  const loadQueue = useCallback(async () => {
    try {
      const data = await callOpenBot<ComputerQueueView>('computers:queue', 'getComputerQueue');
      if (data) setQueue((prev) => (sameJson(prev, data) ? prev : data));
    } catch (err) {
      setActionError((err as Error).message || t('computers.actionError'));
    }
  }, [t]);

  useEffect(() => {
    void loadProbe();
    void loadComputers();
    void loadQueue();
    // Live refresh while this screen is open: list every 5s (the
    // main process also runs the scheduler tick on each list call),
    // probe every 30s for the host-busy banner. Polling pauses while
    // the tab is hidden and resumes (with an immediate refresh) when
    // it becomes visible again. Intervals are cleared on unmount.
    const listTimer = setInterval(() => {
      if (document.hidden) return;
      void loadComputers(true);
      void loadQueue();
    }, COMPUTERS_POLL_MS);
    const probeTimer = setInterval(() => {
      if (document.hidden) return;
      void loadProbe(true);
    }, PROBE_POLL_MS);
    const onVisibility = () => {
      if (!document.hidden) {
        void loadComputers(true);
        void loadProbe(true);
        void loadQueue();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(listTimer);
      clearInterval(probeTimer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [loadProbe, loadComputers, loadQueue]);

  const botsWithoutComputers = bots.filter((b) => !computers.some((c) => c.computer.botId === b.id));

  async function handlePlan() {
    if (botsWithoutComputers.length === 0) return;
    setPlanLoading(true);
    setActionError(null);
    try {
      const data = await callOpenBot<ComputerPlanView>('computers:plan', 'planComputers', {
        botIds: botsWithoutComputers.map((b) => b.id),
      });
      if (data) setPlan(data);
    } catch (err) {
      setActionError((err as Error).message || t('computers.actionError'));
    } finally {
      setPlanLoading(false);
    }
  }

  async function handleCreate() {
    if (botsWithoutComputers.length === 0) return;
    setBusyAction('create');
    setActionError(null);
    try {
      const list = await callOpenBot<ComputerStatusView[]>('computers:create', 'createComputers', {
        botIds: botsWithoutComputers.map((b) => b.id),
      });
      if (list) {
        setComputers(list);
        setPlan(null);
      }
    } catch (err) {
      setActionError((err as Error).message || t('computers.actionError'));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleComputerAction(botId: string, action: 'start' | 'pause' | 'resume' | 'stop') {
    setBusyAction(`${action}:${botId}`);
    setActionError(null);
    try {
      const channel = `computers:${action}` as const;
      const camel =
        action === 'start'
          ? 'startComputer'
          : action === 'pause'
            ? 'pauseComputer'
            : action === 'resume'
              ? 'resumeComputer'
              : 'stopComputer';
      const updated = await callOpenBot<ComputerStatusView>(channel, camel, botId);
      if (updated) {
        setComputers((prev) =>
          prev.map((c) => (c.computer.botId === botId ? updated : c)),
        );
      }
    } catch (err) {
      setActionError((err as Error).message || t('computers.actionError'));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSetVmNetwork(botId: string, network: 'none' | 'nat') {
    setBusyAction(`network:${botId}`);
    setActionError(null);
    try {
      const updated = await callOpenBot<ComputerStatusView>('computers:set-vm-network', 'setComputerVmNetwork', {
        botId,
        network,
      });
      if (updated) {
        setComputers((prev) =>
          prev.map((c) => (c.computer.botId === botId ? updated : c)),
        );
      }
    } catch (err) {
      setActionError((err as Error).message || t('computers.actionError'));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSetVmImage(botId: string) {
    const imagePath = (vmImageInputs[botId] ?? '').trim();
    if (!imagePath) return;
    setBusyAction(`image:${botId}`);
    setActionError(null);
    try {
      const updated = await callOpenBot<ComputerStatusView>('computers:set-vm-image', 'setComputerVmImage', {
        botId,
        imagePath,
      });
      if (updated) {
        setComputers((prev) =>
          prev.map((c) => (c.computer.botId === botId ? updated : c)),
        );
      }
    } catch (err) {
      setActionError((err as Error).message || t('computers.actionError'));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleShed() {
    setBusyAction('shed');
    setActionError(null);
    setShedMessage(null);
    try {
      const result = await callOpenBot<{ paused: string[] }>('computers:shed', 'shedComputers');
      if (result) {
        setShedMessage(t('computers.shedDone', { count: result.paused.length }));
        await loadComputers();
      }
    } catch (err) {
      setActionError((err as Error).message || t('computers.actionError'));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSetPriority(botId: string) {
    const raw = (priorityInputs[botId] ?? '').trim();
    const priority = Number(raw);
    if (raw === '' || !Number.isFinite(priority) || Math.floor(priority) !== priority || priority < 0 || priority > 100) {
      setActionError(t('computers.priorityInvalid'));
      return;
    }
    setBusyAction(`priority:${botId}`);
    setActionError(null);
    try {
      const data = await callOpenBot<ComputerQueueView>('computers:set-priority', 'setComputerPriority', {
        botId,
        priority,
      });
      if (data) setQueue(data);
      await loadComputers(true);
    } catch (err) {
      setActionError((err as Error).message || t('computers.actionError'));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSetAutoShed(enabled: boolean) {
    setBusyAction('auto-shed');
    setActionError(null);
    try {
      const data = await callOpenBot<ComputerQueueView>('computers:set-auto-shed', 'setComputerAutoShed', {
        enabled,
      });
      if (data) setQueue(data);
    } catch (err) {
      setActionError((err as Error).message || t('computers.actionError'));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleCheckGuest(botId: string) {
    setBusyAction(`guest:${botId}`);
    setActionError(null);
    try {
      const health = await callOpenBot<GuestAgentHealthView>('computers:guest-health', 'checkComputerGuestHealth', botId);
      if (health) {
        setComputers((prev) =>
          prev.map((c) =>
            c.computer.botId === botId ? { ...c, guestAgentHealth: health } : c,
          ),
        );
      }
    } catch (err) {
      setActionError((err as Error).message || t('computers.actionError'));
    } finally {
      setBusyAction(null);
    }
  }

  const profile = probe?.profile ?? null;
  const busy = probe?.busy || plan?.busy || false;

  return (
    <div>
      <button type="button" onClick={onBack}>
        ← {t('computers.back')}
      </button>
      <h2>{t('computers.title')}</h2>
      <p>{t('computers.intro')}</p>
      <p>
        <small>{t('computers.liveNote')}</small>
      </p>

      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={() => void loadProbe()}>
            {t('computers.retry')}
          </button>
        </p>
      )}
      {actionError && <p role="alert">{actionError}</p>}
      {shedMessage && <p>{shedMessage}</p>}

      {busy && (
        <p role="alert">
          {t('computers.busy')}{' '}
          <button type="button" onClick={() => void handleShed()} disabled={busyAction === 'shed'}>
            {busyAction === 'shed' ? t('computers.shedding') : t('computers.shedButton')}
          </button>
        </p>
      )}

      <section>
        <h3>{t('computers.probeTitle')}</h3>
        {probeLoading ? (
          <p>{t('computers.probing')}</p>
        ) : profile ? (
          <div>
            <p>
              <strong>{t('computers.os')}:</strong> {profile.osVersion} ({profile.os} {profile.arch}) —{' '}
              {profile.hostname}
            </p>
            <p>
              <strong>{t('computers.cpu')}:</strong> {profile.cpu.model} — {profile.cpu.logicalCores} core
              {profile.cpu.physicalCores !== null ? ` ${t('computers.physicalCores', { count: profile.cpu.physicalCores })}` : ''}
              {profile.cpu.speedMhz !== null ? ` — ${profile.cpu.speedMhz} MHz` : ''}
              {profile.cpu.loadPerCore !== null
                ? ` — ${t('computers.load')}: ${(profile.cpu.loadPerCore * 100).toFixed(0)}%/core`
                : ''}
            </p>
            <p>
              <strong>{t('computers.ram')}:</strong> {formatBytes(profile.memory.freeBytes)} {t('computers.ramFree')} /{' '}
              {formatBytes(profile.memory.totalBytes)}
            </p>
            <p>
              <strong>{t('computers.disk')}:</strong>{' '}
              {profile.disks.map((d) => `${d.mount}: ${formatBytes(d.freeBytes)} ${t('computers.ramFree')} / ${formatBytes(d.totalBytes)}`).join(' · ') ||
                '—'}
            </p>
            <p>
              <strong>{t('computers.virtualization')}:</strong> {profile.virtualization.detail} (
              {profile.virtualization.supported
                ? t('computers.virtualizationSupported')
                : t('computers.virtualizationUnsupported')}
              )
            </p>
            <p>
              <strong>{t('computers.gpu')}:</strong>{' '}
              {profile.gpus.length > 0 ? profile.gpus.map((g) => g.model).join(' · ') : t('computers.noGpu')}
            </p>
            {profile.warnings.length > 0 && (
              <p>
                <strong>{t('computers.planWarnings')}:</strong> {profile.warnings.join(' ')}
              </p>
            )}
          </div>
        ) : null}
        <button type="button" onClick={() => void loadProbe()} disabled={probeLoading}>
          {t('computers.probeAgain')}
        </button>
      </section>

      {probe && (
        <section>
          <h3>{t('computers.backendsTitle')}</h3>
          <ul>
            {probe.backends.map((b) => (
              <li key={b.kind}>
                {b.kind} ({levelLabel(t, b.level)}):{' '}
                {b.available ? t('computers.backendAvailable') : t('computers.backendUnavailable')} — {b.detail}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3>{t('computers.planTitle')}</h3>
        {bots.length === 0 ? (
          <p>{t('computers.noBots')}</p>
        ) : botsWithoutComputers.length === 0 ? (
          <p>{t('computers.allBotsHaveComputers')}</p>
        ) : (
          <div>
            <button type="button" onClick={() => void handlePlan()} disabled={planLoading}>
              {planLoading ? t('computers.planning') : t('computers.planButton')}
            </button>
            {plan ? (
              <div>
                <p>
                  <strong>{t('computers.headroomTitle')}:</strong> {plan.hostHeadroom.cpuCores.toFixed(1)} core ·{' '}
                  {formatBytes(plan.hostHeadroom.ramBytes)} RAM · {formatBytes(plan.hostHeadroom.diskBytes)}{' '}
                  {t('computers.disk')}
                </p>
                {plan.warnings.length > 0 && (
                  <p>
                    <strong>{t('computers.planWarnings')}:</strong> {plan.warnings.join(' ')}
                  </p>
                )}
                <table>
                  <thead>
                    <tr>
                      <th>{t('computers.botLabel')}</th>
                      <th>{t('computers.level')}</th>
                      <th>{t('computers.backend')}</th>
                      <th>{t('computers.cpuAlloc')}</th>
                      <th>{t('computers.ramAlloc')}</th>
                      <th>{t('computers.diskAlloc')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.allocations.map((a) => (
                      <tr key={a.botId}>
                        <td>{botName(a.botId)}</td>
                        <td>
                          {levelLabel(t, a.level)}
                          {a.downgradedFrom ? ` (${t('computers.downgradedFrom', { level: levelLabel(t, a.downgradedFrom) })})` : ''}
                        </td>
                        <td>
                          {a.backend} — {a.backendDetail}
                        </td>
                        <td>{a.cpuCores} core</td>
                        <td>{formatBytes(a.ramBytes)}</td>
                        <td>{formatBytes(a.diskBytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {plan.rejected.length > 0 && (
                  <div>
                    <p>
                      <strong>{t('computers.rejectedTitle')}:</strong>
                    </p>
                    <ul>
                      {plan.rejected.map((r) => (
                        <li key={r.botId}>
                          {botName(r.botId)} — {t('computers.rejectedReason')}: {r.reasonDetail ?? r.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {plan.allocations.length > 0 && (
                  <button type="button" onClick={() => void handleCreate()} disabled={busyAction === 'create'}>
                    {busyAction === 'create' ? t('computers.creating') : t('computers.createButton')}
                  </button>
                )}
              </div>
            ) : (
              <p>{t('computers.noPlan')}</p>
            )}
          </div>
        )}
      </section>

      <section>
        <h3>{t('computers.queueTitle')}</h3>
        <label>
          <input
            type="checkbox"
            checked={queue?.autoShed ?? false}
            disabled={busyAction === 'auto-shed'}
            onChange={(e) => void handleSetAutoShed(e.target.checked)}
          />{' '}
          {t('computers.autoShedLabel')}
        </label>
        <p>
          <small>{t('computers.autoShedHint')}</small>
        </p>
        {!queue || queue.queue.length === 0 ? (
          <p>{t('computers.queueEmpty')}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t('computers.botLabel')}</th>
                <th>{t('computers.priorityLabel')}</th>
                <th>{t('computers.queueReason')}</th>
              </tr>
            </thead>
            <tbody>
              {queue.queue.map((entry) => (
                <tr key={entry.botId}>
                  <td>
                    {botName(entry.botId)}
                    <br />
                    <small>{new Date(entry.enqueuedAt).toLocaleString()}</small>
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={priorityInputs[entry.botId] ?? String(entry.priority)}
                      aria-label={t('computers.priorityLabel')}
                      disabled={busyAction === `priority:${entry.botId}`}
                      onChange={(e) =>
                        setPriorityInputs((prev) => ({ ...prev, [entry.botId]: e.target.value }))
                      }
                    />{' '}
                    <button
                      type="button"
                      onClick={() => void handleSetPriority(entry.botId)}
                      disabled={busyAction === `priority:${entry.botId}`}
                    >
                      {t('computers.priorityApply')}
                    </button>
                  </td>
                  <td>{entry.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h3>{t('computers.allocationsTitle')}</h3>
        {computersLoading ? (
          <p>{t('computers.loading')}</p>
        ) : computers.length === 0 ? (
          <p>{t('computers.computersEmpty')}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t('computers.botLabel')}</th>
                <th>{t('computers.level')}</th>
                <th>{t('computers.effectiveLevel')}</th>
                <th>{t('computers.state')}</th>
                <th>{t('computers.cpuAlloc')}</th>
                <th>{t('computers.ramAlloc')}</th>
                <th>{t('computers.diskUsed')}</th>
                <th>{t('computers.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {computers.map(({ computer, effectiveLevel, levelWarning, vmNetworkWarning, guestAgentConnected, guestAgentHealth }) => (
                <tr key={computer.id}>
                  <td>
                    {botName(computer.botId)}
                    <br />
                    <small>{computer.backend} — {computer.backendDetail}</small>
                    {computer.lastError && (
                      <p role="alert">
                        <small>{computer.lastError}</small>
                      </p>
                    )}
                    {computer.state === 'paused' && computer.lastPauseReason && (
                      <p>
                        <small>
                          {t('computers.pausedReason')}: {computer.lastPauseReason}
                        </small>
                      </p>
                    )}
                    {levelWarning && (
                      <p>
                        <small>{levelWarning}</small>
                      </p>
                    )}
                    {vmNetworkWarning && (
                      <p role="alert">
                        <small>{vmNetworkWarning}</small>
                      </p>
                    )}
                    {computer.level === 'vm' && (
                      <p>
                        <small>
                          {t('computers.guestLabel')}: {guestHealthLabel(t, guestAgentHealth)}
                          {guestAgentHealth?.version
                            ? ` — ${t('computers.guestVersion', { version: guestAgentHealth.version })}`
                            : ''}
                          {guestAgentHealth?.uptimeSeconds !== undefined
                            ? ` — ${t('computers.guestUptime', { seconds: guestAgentHealth.uptimeSeconds })}`
                            : ''}
                          {guestAgentConnected === false && guestAgentHealth?.status !== 'ok'
                            ? ` (${t('computers.guestNotConnected')})`
                            : ''}
                        </small>
                        {guestAgentHealth?.hint && (
                          <span>
                            <br />
                            <small>{guestAgentHealth.hint}</small>
                          </span>
                        )}{' '}
                        <button
                          type="button"
                          onClick={() => void handleCheckGuest(computer.botId)}
                          disabled={busyAction === `guest:${computer.botId}`}
                        >
                          {busyAction === `guest:${computer.botId}`
                            ? t('computers.guestChecking')
                            : t('computers.guestCheck')}
                        </button>
                      </p>
                    )}
                  </td>
                  <td>{levelLabel(t, computer.level)}</td>
                  <td>{levelLabel(t, effectiveLevel)}</td>
                  <td>{stateLabel(t, computer.state)}</td>
                  <td>{computer.cpuCores} core</td>
                  <td>{formatBytes(computer.ramBytes)}</td>
                  <td>{computer.diskUsedBytes != null ? formatBytes(computer.diskUsedBytes) : '—'}</td>
                  <td>
                    {computer.state === 'running' ? (
                      <button
                        type="button"
                        onClick={() => void handleComputerAction(computer.botId, 'pause')}
                        disabled={busyAction === `pause:${computer.botId}`}
                      >
                        {t('computers.pause')}
                      </button>
                    ) : computer.state === 'paused' ? (
                      <button
                        type="button"
                        onClick={() => void handleComputerAction(computer.botId, 'resume')}
                        disabled={busyAction === `resume:${computer.botId}`}
                      >
                        {t('computers.resume')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleComputerAction(computer.botId, 'start')}
                        disabled={busyAction === `start:${computer.botId}`}
                      >
                        {t('computers.start')}
                      </button>
                    )}{' '}
                    {computer.state !== 'stopped' && (
                      <button
                        type="button"
                        onClick={() => void handleComputerAction(computer.botId, 'stop')}
                        disabled={busyAction === `stop:${computer.botId}`}
                      >
                        {t('computers.stop')}
                      </button>
                    )}
                    {computer.level === 'vm' && (
                      <div>
                        <input
                          type="text"
                          value={vmImageInputs[computer.botId] ?? computer.imagePath ?? ''}
                          placeholder={t('computers.vmImagePlaceholder')}
                          aria-label={t('computers.vmImageLabel')}
                          onChange={(e) =>
                            setVmImageInputs((prev) => ({ ...prev, [computer.botId]: e.target.value }))
                          }
                        />{' '}
                        <button
                          type="button"
                          onClick={() => void handleSetVmImage(computer.botId)}
                          disabled={busyAction === `image:${computer.botId}`}
                        >
                          {t('computers.vmImageSet')}
                        </button>
                        {!computer.imagePath && <p><small>{t('computers.vmImageMissing')}</small></p>}
                        <label>
                          {t('computers.vmNetworkLabel')}{' '}
                          <select
                            value={computer.vmNetwork ?? 'none'}
                            aria-label={t('computers.vmNetworkLabel')}
                            disabled={busyAction === `network:${computer.botId}`}
                            onChange={(e) =>
                              void handleSetVmNetwork(
                                computer.botId,
                                e.target.value === 'nat' ? 'nat' : 'none',
                              )
                            }
                          >
                            <option value="none">{t('computers.vmNetworkNone')}</option>
                            <option value="nat">{t('computers.vmNetworkNat')}</option>
                          </select>
                        </label>
                        <p><small>{t('computers.vmNetworkHint')}</small></p>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
