import { useEffect, useRef } from 'react';
import { useT } from '../i18n/useT';
import type { CallTranscriptLine } from '../voice/voiceUi';

/**
 * Call view (v0.59) — the dedicated panel for a live voice call.
 *
 * Shows the call status (connecting / active / ended), the live
 * transcript as it arrives, the last voice tool the model called,
 * and the End call button. It registers itself as a voice surface
 * with view 'call' while mounted (v0.56 surface register): the
 * surface on record drives the session-instructions guidance and
 * the spoken-reply length cap, so the call view — not the chat
 * behind it — shapes the model's replies while the user is looking
 * at it. Unregisters on unmount; the chat surface stays registered.
 *
 * Presentational except for the surface register: audio capture,
 * connect/disconnect and the transcript subscription live in
 * ChatView, which passes the state down.
 */
export type VoiceSurfaceOption = 'desk' | 'web' | 'phone' | 'carplay' | 'headphones';

export type CallStatus = 'connecting' | 'active' | 'ended';

interface Props {
  botId: string;
  botName: string;
  status: CallStatus;
  transcripts: CallTranscriptLine[];
  lastTool: string | null;
  surface: VoiceSurfaceOption;
  onSurfaceChange: (surface: VoiceSurfaceOption) => void;
  onEndCall: () => void;
}

export default function CallView({
  botId,
  botName,
  status,
  transcripts,
  lastTool,
  surface,
  onSurfaceChange,
  onEndCall,
}: Props) {
  const t = useT();
  const bodyRef = useRef<HTMLDivElement>(null);
  const surfaceIdRef = useRef<string | null>(null);

  // v0.59: this view is the surface on record while the call panel
  // is open (view 'call' — see main's voice:surface-register).
  useEffect(() => {
    const api = window.openBot;
    if (typeof api.voiceSurfaceRegister !== 'function') return;
    let alive = true;
    void api.voiceSurfaceRegister(botId, surface, 'call').then((r) => {
      if (alive && r.ok && r.surfaceId) surfaceIdRef.current = r.surfaceId;
    });
    return () => {
      alive = false;
      const id = surfaceIdRef.current;
      surfaceIdRef.current = null;
      if (id && typeof api.voiceSurfaceUnregister === 'function') {
        void api.voiceSurfaceUnregister(id);
      }
    };
  }, [botId, surface]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcripts]);

  const statusText =
    status === 'connecting'
      ? t('voice.callConnecting')
      : status === 'active'
        ? t('voice.callActive')
        : t('voice.callEnded');

  return (
    <section className="card call-view" data-testid="call-view" aria-label={t('voice.callTitle')}>
      <div className="row">
        <strong>
          {t('voice.callTitle', { name: botName })}
        </strong>
        <span className="status" data-testid="call-status">
          {statusText}
        </span>
      </div>
      <div className="call-transcript" data-testid="call-transcript" ref={bodyRef}>
        {transcripts.length === 0 && <p className="empty">{t('voice.callTranscriptEmpty')}</p>}
        {transcripts.map((line) => (
          <p key={line.id} className={line.isFinal ? 'msg assistant' : 'msg assistant interim'}>
            {line.text}
          </p>
        ))}
      </div>
      {lastTool && (
        <p className="hint">
          {t('voice.toolCalled', { name: lastTool })}
        </p>
      )}
      <div className="row">
        <label>
          {t('voice.surfaceLabel')}{' '}
          <select
            value={surface}
            onChange={(e) => onSurfaceChange(e.target.value as VoiceSurfaceOption)}
            aria-label={t('voice.surfaceLabel')}
          >
            <option value="desk">{t('voice.surface.desk')}</option>
            <option value="web">{t('voice.surface.web')}</option>
            <option value="phone">{t('voice.surface.phone')}</option>
            <option value="carplay">{t('voice.surface.carplay')}</option>
            <option value="headphones">{t('voice.surface.headphones')}</option>
          </select>
        </label>
        <button
          className="btn"
          data-testid="call-end"
          onClick={onEndCall}
          disabled={status === 'ended'}
        >
          {t('voice.callEnd')}
        </button>
      </div>
    </section>
  );
}
