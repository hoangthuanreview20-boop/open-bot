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

interface Props {
  available: boolean;
  provider: RealtimeProviderOption;
  turnMode: RealtimeTurnModeOption;
  state: RealtimePanelState;
  bargeInCount: number;
  talkHeld: boolean;
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
      {!available && <p className="hint">{t('voice.realtime.notAvailable')}</p>}
      <p className="hint">{t('voice.realtime.hint')}</p>
    </section>
  );
}
