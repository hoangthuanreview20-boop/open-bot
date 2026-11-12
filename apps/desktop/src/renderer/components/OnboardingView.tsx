/**
 * OnboardingView — first-run screen (UI-10, v0.60).
 *
 * Shown in place of the chat when the app has no bot yet and the user
 * never finished or dismissed onboarding (see onboarding.ts + App).
 * Three steps, doable in a minute: create a sample bot in one click
 * (or a bot of your own), add a provider key or use a local model, then
 * chat. "Skip" dismisses it for good — the flag is stored in
 * localStorage and the screen never comes back.
 *
 * Presentational only: App owns the flag, the template load and the
 * createBot call, so this component needs no IPC and no tests of its
 * own beyond the i18n keys it uses.
 */
import { useT } from '../i18n/useT';
import { onboardingModelPaths } from './onboarding';

interface Props {
  onCreateSample: () => void;
  onCreateBot: () => void;
  onDismiss: () => void;
  creatingSample: boolean;
  sampleError: string | null;
}

export default function OnboardingView({
  onCreateSample,
  onCreateBot,
  onDismiss,
  creatingSample,
  sampleError,
}: Props) {
  const t = useT();
  return (
    <div className="panel">
      <div className="onboarding">
        <h2>{t('onboarding.title')}</h2>
        <p>{t('onboarding.intro')}</p>
        <ol className="onboarding-steps">
          <li>
            <strong>{t('onboarding.step1Title')}</strong>
            <br />
            {t('onboarding.step1Text')}
          </li>
          <li>
            <strong>{t('onboarding.step2Title')}</strong>
            <br />
            {t('onboarding.step2Text')}
            <p className="onboarding-keyless">{t('onboarding.keylessTitle')}</p>
            <div className="onboarding-paths">
              {onboardingModelPaths().map((p) => (
                <div key={p.id} className="onboarding-path">
                  <strong>{t(p.titleKey)}</strong>
                  <br />
                  {t(p.textKey)}
                </div>
              ))}
            </div>
          </li>
          <li>
            <strong>{t('onboarding.step3Title')}</strong>
            <br />
            {t('onboarding.step3Text')}
          </li>
        </ol>
        {sampleError && <p className="error">{t('common.error', { message: sampleError })}</p>}
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <button className="btn" disabled={creatingSample} onClick={onCreateSample}>
            {creatingSample ? t('onboarding.creatingSample') : t('onboarding.createSample')}
          </button>
          <button className="btn secondary" onClick={onCreateBot}>
            {t('onboarding.createOwn')}
          </button>
        </div>
        <p className="onboarding-hint">{t('onboarding.keyHint')}</p>
        <p>
          <button className="btn secondary" onClick={onDismiss}>
            {t('onboarding.dismiss')}
          </button>
        </p>
      </div>
    </div>
  );
}
