import { useState } from 'react';
import type { UpdateStatusView } from '../types';
import { useT } from '../i18n/useT';

interface Props {
  status: UpdateStatusView;
  onCheckAgain: () => void;
  onOpenDownload: (url: string) => void;
}

/**
 * Update banner (P1-9): shown when a newer release is available on the
 * selected track, or when the server policy requires an update. Dismiss
 * only hides it for this session. Since v0.59 every track checks a real
 * feed (stable: releases latest; others: releases list filtered by
 * channel tag), so `available` can be true on any track once a release
 * for that channel is published — see docs/update-tracks.md.
 */
export default function UpdateBanner({ status, onCheckAgain, onOpenDownload }: Props) {
  const t = useT();
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  if (!status.available && !status.updateRequiredByPolicy) return null;
  const required = status.updateRequiredByPolicy;
  return (
    <div className="notice" role="alert" style={{ margin: '0 20px 12px' }}>
      <strong>{required ? t('update.requiredTitle') : t('update.availableTitle')}</strong>{' '}
      {status.latestVersion
        ? t('update.availableLine', { version: status.latestVersion, current: status.currentVersion })
        : t('update.requiredLine', { current: status.currentVersion })}
      <div className="row wrap" style={{ marginTop: 8 }}>
        {status.htmlUrl && (
          <button className="btn ok" onClick={() => onOpenDownload(status.htmlUrl as string)}>
            {t('update.openDownload')}
          </button>
        )}
        <button className="btn" onClick={onCheckAgain}>
          {t('update.checkAgain')}
        </button>
        {!required && (
          <button className="btn secondary" onClick={() => setDismissed(true)}>
            {t('update.dismiss')}
          </button>
        )}
      </div>
      {required && <p className="hint" style={{ margin: '8px 0 0' }}>{t('update.requiredHint')}</p>}
    </div>
  );
}
