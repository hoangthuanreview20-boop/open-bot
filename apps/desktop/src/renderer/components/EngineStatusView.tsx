import type { DetectedEnginesView } from '../types';
import { useT } from '../i18n/useT';

/**
 * EngineStatusView (M4) — the engine status list for Settings →
 * Engines, extracted from SettingsView so the status UI lives in one
 * place: one row per engine with binary, version, status, account
 * label (label only, never a token), the reason when unavailable,
 * the opt-in state, a per-engine Re-detect button, and the toggle.
 * Custom ACP rows also get Edit / Remove (handled by SettingsView,
 * which owns the "Set CLI…" form).
 */

type Engine = DetectedEnginesView['engines'][string];

interface Props {
  engines: DetectedEnginesView;
  /** kind currently being re-detected (its button shows a spinner label). */
  redetectingKind: string | null;
  onToggle: (kind: string, enabled: boolean) => void;
  onRedetectOne: (kind: string) => void;
  onEditCustom: (engine: Engine) => void;
  onRemoveCustom: (engine: Engine) => void;
}

export default function EngineStatusView({
  engines,
  redetectingKind,
  onToggle,
  onRedetectOne,
  onEditCustom,
  onRemoveCustom,
}: Props) {
  const t = useT();

  /** An engine's unavailable reason (code -> i18n text). */
  const engineReasonText = (engine: Engine): string => {
    // A custom CLI without a status command reports 'unknown'
    // (sign-in state not checked) — show that instead of a reason code.
    if (engine.status === 'unknown') return t('settings.enginesReasonUnknown');
    switch (engine.reason) {
      case 'not-installed':
        return t('settings.enginesReasonNotInstalled');
      case 'version-too-old':
        return t('settings.enginesReasonVersionTooOld', {
          version: engine.version ?? '?',
          minVersion: engine.minVersion,
        });
      case 'not-signed-in':
        return t('settings.enginesReasonNotSignedIn');
      case 'version-probe-failed':
        return t('settings.enginesReasonProbeFailed');
      case 'auth-check-failed':
        return t('settings.enginesReasonAuthFailed');
      default:
        return engine.reasonDetail ?? '';
    }
  };

  return (
    <ul>
      {Object.values(engines.engines).map((engine) => (
        <li key={engine.kind}>
          <label>
            <input
              type="checkbox"
              checked={engine.enabled}
              onChange={(e) => onToggle(engine.kind, e.target.checked)}
            />
            {t('settings.enginesEnabled')}
          </label>
          {' '}
          <strong>{engine.label}</strong>
          {' — '}
          {engine.status === 'available'
            ? t('settings.enginesAvailable')
            : engine.status === 'unknown'
              ? t('settings.enginesUnknown')
              : t('settings.enginesUnavailable')}
          {' · '}
          {engine.enabled ? t('settings.enginesOptInOn') : t('settings.enginesOptInOff')}
          {engine.binaryPath && (
            <>
              {' · '}
              {t('settings.enginesBinary', { path: engine.binaryPath })}
            </>
          )}
          {engine.version && (
            <>
              {' · '}
              {t('settings.enginesVersion', { version: engine.version })}
            </>
          )}
          {engine.account?.label && (
            <>
              {' · '}
              {t('settings.enginesAccount', { label: engine.account.label })}
            </>
          )}
          {engine.status !== 'available' && (
            <>
              {' — '}
              {engineReasonText(engine)}
            </>
          )}
          {' '}
          <button
            className="btn secondary"
            onClick={() => onRedetectOne(engine.kind)}
            disabled={redetectingKind === engine.kind}
          >
            {redetectingKind === engine.kind
              ? t('settings.enginesRedetectingOne')
              : t('settings.enginesRedetectOne')}
          </button>
          {engine.kind.startsWith('custom-acp:') && (
            <>
              {' '}
              <button className="btn secondary" onClick={() => onEditCustom(engine)}>
                {t('settings.customCliEdit')}
              </button>{' '}
              <button className="btn secondary" onClick={() => onRemoveCustom(engine)}>
                {t('settings.customCliRemove')}
              </button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
