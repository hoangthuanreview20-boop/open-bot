import { useT } from '../i18n/useT';

interface Props {
  message: string;
  onDismiss: () => void;
}

/**
 * v0.62 (UI-13): unified error banner — the same shape as the A2A persist
 * banner (v0.28): red left border, `role="alert"`, dismiss button.
 *
 * It replaces the old fixed bottom-right `<p className="error">` in App,
 * which was easy to miss behind other panels, had no close button and
 * gave no severity. Rendered at the top of the main column (next to the
 * A2A/Update banners) so it shows in every view. Dismiss only clears
 * this error — the next `loadError` shows again.
 */
export default function AppErrorBanner({ message, onDismiss }: Props) {
  const t = useT();
  return (
    <div className="app-alert" role="alert" data-testid="app-error-banner">
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong>{message}</strong>
      </div>
      <button className="btn secondary" onClick={onDismiss}>
        {t('a2a.persistDismiss')}
      </button>
    </div>
  );
}
