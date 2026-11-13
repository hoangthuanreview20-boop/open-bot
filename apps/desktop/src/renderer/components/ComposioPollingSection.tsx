/**
 * ComposioPollingSection (v0.98 Team T3) — the background-poll panel in
 * Connected apps, under the Composio section.
 *
 * Props-driven, it does NOT call IPC directly: the host
 * (ConnectedAppsView via useConnectedApps) passes status + callbacks;
 * main connects the callbacks to the IPC channels
 * `composio:get-poll-status` / `composio:set-poll-config` /
 * `composio:poll-now` (see docs/composio-integration.md §18).
 *
 * i18n: all display strings live in locales/*.json under
 * `settings.composioPoll.*` and are read through useT() — no
 * hard-coded strings in this file. Times are ms epoch (0 = never);
 * the component only formats them, it never shows key/token/mail
 * content (status carries none of those).
 */

import { useState } from 'react';
import { useT } from '../i18n/useT';
import type { ComposioPollStatusView } from '../types';

export interface ComposioPollingSectionProps {
  /** Per-poller status (null = never loaded). */
  statuses: ComposioPollStatusView[] | null;
  /** True while the first load is running. */
  loading: boolean;
  /** True while saving config / polling manually — buttons locked. */
  busy: boolean;
  /** Most recent error (shown, never contains a key). */
  error?: string;
  /** Whether a Composio API key is configured — without one, poll-now is locked. */
  keyConfigured: boolean;
  /** Reload the status. */
  onRefresh: () => void;
  /** Poll one poller right now (manual). */
  onPollNow: (name: string) => void;
  /** Enable/disable a poller. */
  onSetEnabled: (name: string, enabled: boolean) => void;
  /** Change one poller's poll interval (minutes). */
  onSetInterval: (name: string, intervalMinutes: number) => void;
}

function formatTime(t: ReturnType<typeof useT>, ms: number): string {
  if (!ms) return t('settings.composioPoll.never');
  return new Date(ms).toLocaleString();
}

function PollerRow(props: {
  status: ComposioPollStatusView;
  busy: boolean;
  keyConfigured: boolean;
  onPollNow: (name: string) => void;
  onSetEnabled: (name: string, enabled: boolean) => void;
  onSetInterval: (name: string, intervalMinutes: number) => void;
}) {
  const t = useT();
  const { status } = props;
  const [minutesDraft, setMinutesDraft] = useState<string>(String(Math.round(status.intervalMs / 60000)));
  const minutes = Number(minutesDraft);
  const intervalValid = Number.isFinite(minutes) && minutes >= 1 && minutes <= 1440;
  const intervalChanged = intervalValid && Math.round(status.intervalMs / 60000) !== Math.round(minutes);
  return (
    <div className="card" data-testid={`composio-poll-${status.name}`}>
      <p>
        <strong>{status.name}</strong> · {status.toolkit} · {status.toolSlug}
      </p>
      <p className="hint">
        {status.enabled
          ? status.running
            ? t('settings.composioPoll.running')
            : t('settings.composioPoll.enabledPaused')
          : t('settings.composioPoll.disabled')}
        {' · '}
        {t('settings.composioPoll.triggerSlug')}: {status.triggerSlug}
      </p>
      <div>
        <button
          className="btn secondary"
          disabled={props.busy}
          onClick={() => void props.onSetEnabled(status.name, !status.enabled)}
        >
          {status.enabled ? t('settings.composioPoll.disable') : t('settings.composioPoll.enable')}
        </button>{' '}
        <button
          className="btn secondary"
          disabled={props.busy || !props.keyConfigured}
          onClick={() => void props.onPollNow(status.name)}
        >
          {t('settings.composioPoll.pollNow')}
        </button>
      </div>
      <div>
        <label htmlFor={`composio-poll-interval-${status.name}`}>
          {t('settings.composioPoll.intervalLabel')}
        </label>{' '}
        <input
          id={`composio-poll-interval-${status.name}`}
          type="number"
          min={1}
          max={1440}
          value={minutesDraft}
          disabled={props.busy}
          onChange={(e) => setMinutesDraft(e.target.value)}
        />{' '}
        <button
          className="btn secondary"
          disabled={props.busy || !intervalChanged}
          onClick={() => void props.onSetInterval(status.name, Math.round(minutes))}
        >
          {t('settings.composioPoll.intervalSave')}
        </button>{' '}
        <span className="hint">{t('settings.composioPoll.intervalHint')}</span>
      </div>
      <p className="hint">
        {t('settings.composioPoll.lastPolled')}: {formatTime(t, status.lastPolledAtMs)}
        {' · '}
        {t('settings.composioPoll.lastSuccess')}: {formatTime(t, status.lastSuccessAtMs)}
        {' · '}
        {t('settings.composioPoll.nextPoll')}: {formatTime(t, status.nextPollAtMs)}
      </p>
      <p className="hint">
        {t('settings.composioPoll.totalPolls')}: {status.totalPolls}
        {' · '}
        {t('settings.composioPoll.totalNewItems')}: {status.totalNewItems}
        {' · '}
        {t('settings.composioPoll.seenCount')}: {status.seenCount}
        {' · '}
        {t('settings.composioPoll.queuePending')}: {status.queuePending}
      </p>
      {status.consecutiveFailures > 0 && (
        <p className="hint">
          {t('settings.composioPoll.failures', { count: String(status.consecutiveFailures) })}
          {status.lastError ? ` — ${status.lastError}` : ''}
        </p>
      )}
      {!props.keyConfigured && <p className="hint">{t('settings.composioPoll.keyMissing')}</p>}
    </div>
  );
}

export function ComposioPollingSection(props: ComposioPollingSectionProps) {
  const t = useT();
  return (
    <section className="card">
      <h3>{t('settings.composioPoll.title')}</h3>
      <p className="hint">{t('settings.composioPoll.intro')}</p>
      {props.error && <p className="error">{props.error}</p>}
      {props.loading && !props.statuses ? (
        <p className="hint" data-testid="composio-poll-loading">
          {t('settings.composioPoll.loading')}
        </p>
      ) : props.statuses && props.statuses.length > 0 ? (
        <>
          {props.statuses.map((status) => (
            <PollerRow
              key={status.name}
              status={status}
              busy={props.busy}
              keyConfigured={props.keyConfigured}
              onPollNow={props.onPollNow}
              onSetEnabled={props.onSetEnabled}
              onSetInterval={props.onSetInterval}
            />
          ))}
          <div>
            <button className="btn secondary" disabled={props.busy} onClick={() => void props.onRefresh()}>
              {t('settings.composioPoll.refresh')}
            </button>
          </div>
        </>
      ) : (
        <p className="hint" data-testid="composio-poll-empty">
          {t('settings.composioPoll.empty')}
        </p>
      )}
    </section>
  );
}
