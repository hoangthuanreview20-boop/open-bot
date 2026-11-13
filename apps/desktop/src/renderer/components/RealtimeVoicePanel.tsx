import { useT } from '../i18n/useT';

/**
 * Realtime voice panel (v0.95, Team D3) — the live 2-way voice
 * conversation controls, rendered inside ChatView next to CallView
 * while a realtime session is available.
 *
 * Presentational: connect/disconnect, mic capture and the transcript
 * subscription live in ChatView; this panel only renders the state
 * and fires the callbacks. Provider + turn-taking mode are chosen
 * here (advanced controls behind the panel, not in the composer):
 *
 *   - provider: openai (OpenAI Realtime wire) / gemini (Gemini
 *     Live) — the bot's provider is the default.
 *   - turn mode: server_vad (default), local_vad, push_to_talk
 *     (hold the talk button).
 *
 * While the model speaks, the Interrupt button (and the server/local
 * VAD) barges in: the response is cancelled and playback flushed.
 * The barge-in counter shows how often that happened this session.
 */
export type RealtimeProviderOption = 'openai' | 'gemini' | 'openai-compatible';
export type RealtimeTurnModeOption = 'server_vad' | 'local_vad' | 'push_to_talk';
export type RealtimePanelState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'speaking'
  | 'interrupted'
  | 'reconnecting'
  | 'closed';

/** Per-adapter health, as the main process reports it (v0.96). */
export interface RealtimeAdapterHealth {
  provider: string;
  status: 'unknown' | 'healthy' | 'degraded' | 'down';
  keyConfigured: boolean;
  connected: boolean;
  connectLatencyMs: number | null;
  firstAudioLatencyMs: number | null;
  detail?: string;
  /** True when this is the mock fallback, not a live adapter. */
  mock?: boolean;
}

/** Measured barge-in stats, as main reports them (v0.98). */
export interface RealtimeBargeInStats {
  count: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  lastMs: number | null;
  breaches: number;
  budgetMs: number;
}

/** One live transcript line (from the voice:transcript channel). */
export interface RealtimeTranscriptLine {
  text: string;
  isFinal: boolean;
}

interface Props {
  available: boolean;
  provider: RealtimeProviderOption;
  turnMode: RealtimeTurnModeOption;
  state: RealtimePanelState;
  bargeInCount: number;
  talkHeld: boolean;
  /** Per-adapter health from main (v0.96 — null until connected). */
  adapterHealth?: RealtimeAdapterHealth | null;
  /** Measured barge-in stats from main (v0.98 — null until measured). */
  bargeInStats?: RealtimeBargeInStats | null;
  /** Live transcript lines, oldest first (v0.96 — last lines shown). */
  transcript?: RealtimeTranscriptLine[];
  /** Persisted session id (v0.96 — resumed sessions keep it). */
  sessionId?: string;
  onProviderChange: (provider: RealtimeProviderOption) => void;
  onTurnModeChange: (mode: RealtimeTurnModeOption) => void;
  onStart: () => void;
  onStop: () => void;
  onInterrupt: () => void;
  onTalkHold: (held: boolean) => void;
}

export default function RealtimeVoicePanel({
  available,
  provider,
  turnMode,
  state,
  bargeInCount,
  talkHeld,
  adapterHealth,
  bargeInStats,
  transcript,
  sessionId,
  onProviderChange,
  onTurnModeChange,
  onStart,
  onStop,
  onInterrupt,
  onTalkHold,
}: Props) {
  const t = useT();
  const active = state === 'listening' || state === 'speaking' || state === 'interrupted';
  const connecting = state === 'connecting' || state === 'reconnecting';

  const stateText =
    state === 'connecting'
      ? t('voice.realtime.stateConnecting')
      : state === 'listening'
        ? t('voice.realtime.stateListening')
        : state === 'speaking'
          ? t('voice.realtime.stateSpeaking')
          : state === 'interrupted'
            ? t('voice.realtime.stateInterrupted')
            : state === 'reconnecting'
              ? t('voice.realtime.stateReconnecting')
              : state === 'closed'
                ? t('voice.realtime.stateClosed')
                : t('voice.realtime.stateIdle');

  const healthText = adapterHealth
    ? adapterHealth.status === 'healthy'
      ? t('voice.realtime.live.healthHealthy')
      : adapterHealth.status === 'degraded'
        ? t('voice.realtime.live.healthDegraded')
        : adapterHealth.status === 'down'
          ? t('voice.realtime.live.healthDown')
          : t('voice.realtime.live.healthUnknown')
    : null;
  const latencyText =
    adapterHealth?.connectLatencyMs !== null && adapterHealth?.connectLatencyMs !== undefined
      ? t('voice.realtime.live.latency', {
          connect: String(adapterHealth.connectLatencyMs),
          firstAudio:
            adapterHealth.firstAudioLatencyMs === null ||
            adapterHealth.firstAudioLatencyMs === undefined
              ? '—'
              : String(adapterHealth.firstAudioLatencyMs),
        })
      : t('voice.realtime.live.latencyUnknown');
  const liveLines = (transcript ?? []).slice(-6);

  return (
    <section
      className="card realtime-voice-panel"
      data-testid="realtime-voice-panel"
      aria-label={t('voice.realtime.title')}
    >
      <div className="row">
        <strong>{t('voice.realtime.title')}</strong>
        <span className="status" data-testid="realtime-state">
          {stateText}
        </span>
      </div>
      <div className="row">
        <label>
          {t('voice.realtime.provider')}{' '}
          <select
            value={provider}
            onChange={(e) => onProviderChange(e.target.value as RealtimeProviderOption)}
            aria-label={t('voice.realtime.provider')}
            disabled={active || connecting}
            data-testid="realtime-provider"
          >
            <option value="openai">{t('voice.realtime.providerOpenai')}</option>
            <option value="gemini">{t('voice.realtime.providerGemini')}</option>
            <option value="openai-compatible">{t('voice.realtime.providerOpenaiCompatible')}</option>
          </select>
        </label>
        <label>
          {t('voice.realtime.turnMode')}{' '}
          <select
            value={turnMode}
            onChange={(e) => onTurnModeChange(e.target.value as RealtimeTurnModeOption)}
            aria-label={t('voice.realtime.turnMode')}
            data-testid="realtime-turn-mode"
          >
            <option value="server_vad">{t('voice.realtime.turnServerVad')}</option>
            <option value="local_vad">{t('voice.realtime.turnLocalVad')}</option>
            <option value="push_to_talk">{t('voice.realtime.turnPushToTalk')}</option>
          </select>
        </label>
      </div>
      <div className="row">
        {!active && !connecting && (
          <button
            className="btn"
            data-testid="realtime-start"
            onClick={onStart}
            disabled={!available}
          >
            {t('voice.realtime.start')}
          </button>
        )}
        {(active || connecting) && (
          <button className="btn" data-testid="realtime-stop" onClick={onStop}>
            {t('voice.realtime.stop')}
          </button>
        )}
        {state === 'speaking' && (
          <button className="btn" data-testid="realtime-interrupt" onClick={onInterrupt}>
            {t('voice.realtime.interrupt')}
          </button>
        )}
        {turnMode === 'push_to_talk' && active && (
          <button
            className="btn"
            data-testid="realtime-talk"
            onMouseDown={() => onTalkHold(true)}
            onMouseUp={() => onTalkHold(false)}
            onMouseLeave={() => {
              if (talkHeld) onTalkHold(false);
            }}
            onTouchStart={() => onTalkHold(true)}
            onTouchEnd={() => onTalkHold(false)}
          >
            {talkHeld ? t('voice.realtime.talking') : t('voice.realtime.holdToTalk')}
          </button>
        )}
      </div>
      {bargeInCount > 0 && (
        <p className="hint" data-testid="realtime-bargeins">
          {t('voice.realtime.bargeIns', { count: String(bargeInCount) })}
        </p>
      )}
      {/* v0.98 (Team T5 — voice live): measured barge-in stats
          (mean / p95 / last against the 500 ms budget). */}
      {bargeInStats && bargeInStats.count > 0 && (
        <p className="hint" data-testid="realtime-bargein-stats">
          {t('voice.realtime.live.bargeInStats', {
            count: String(bargeInStats.count),
            mean: String(bargeInStats.meanMs),
            p95: String(bargeInStats.p95Ms),
            last: bargeInStats.lastMs === null ? '—' : String(bargeInStats.lastMs),
            budget: String(bargeInStats.budgetMs),
          })}
          {bargeInStats.breaches > 0 && (
            <>
              {' '}
              {t('voice.realtime.live.bargeInBreaches', {
                breaches: String(bargeInStats.breaches),
              })}
            </>
          )}
        </p>
      )}
      {/* v0.96 (Team T5 — voice live): per-adapter health + latency. */}
      {adapterHealth && (
        <div data-testid="realtime-adapter-health">
          {adapterHealth.mock && (
            <p className="hint" data-testid="realtime-mock-mode">
              {t('voice.realtime.live.mockMode')}
            </p>
          )}
          <p className="hint">
            {t('voice.realtime.live.adapterStatus', {
              provider: adapterHealth.provider,
              status: healthText ?? '',
            })}{' '}
            —{' '}
            {adapterHealth.keyConfigured
              ? t('voice.realtime.live.keyConfigured')
              : t('voice.realtime.live.keyMissing')}
          </p>
          <p className="hint" data-testid="realtime-latency">
            {latencyText}
          </p>
          {adapterHealth.detail && adapterHealth.status !== 'healthy' && (
            <p className="hint">{adapterHealth.detail}</p>
          )}
        </div>
      )}
      {/* v0.96 (Team T5 — voice live): live transcript in the panel. */}
      <div data-testid="realtime-transcript">
        <p className="hint">
          <strong>{t('voice.realtime.live.transcriptTitle')}</strong>
        </p>
        {liveLines.length === 0 ? (
          <p className="hint">{t('voice.realtime.live.transcriptEmpty')}</p>
        ) : (
          <ul>
            {liveLines.map((line, i) => (
              <li key={`${i}-${line.text.slice(0, 24)}`}>
                {line.text}
                {!line.isFinal && ` ${t('voice.realtime.live.transcriptInterim')}`}
              </li>
            ))}
          </ul>
        )}
      </div>
      {sessionId && (
        <p className="hint" data-testid="realtime-session-id">
          {t('voice.realtime.live.sessionResumed', { id: sessionId })}
        </p>
      )}
      {!available && <p className="hint">{t('voice.realtime.notAvailable')}</p>}
      <p className="hint">{t('voice.realtime.hint')}</p>
    </section>
  );
}
