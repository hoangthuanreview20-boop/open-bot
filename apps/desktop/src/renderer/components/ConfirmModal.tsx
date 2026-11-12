import { useEffect } from 'react';
import { useT } from '../i18n/useT';

/**
 * Shared in-app confirm modal — the replacement for `window.confirm`
 * everywhere in the renderer. The last two native dialogs (the L5
 * vault flush/discard questions in SettingsView.changeNoStorage)
 * moved here in v0.71; no renderer code calls `window.confirm` any
 * more (enforced by tests/confirm-modal.test.mjs).
 *
 * Follows the delete-bot modal in App.tsx: same backdrop/modal classes,
 * role="alertdialog", backdrop click cancels, Esc cancels. Cancel never
 * runs the action; only the confirm button does.
 */
export interface ConfirmModalProps {
  title: string;
  message: string;
  confirmLabel: string;
  /** Danger styling for the confirm button (delete/remove). Defaults to true. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmModal({
  title,
  message,
  confirmLabel,
  danger = true,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const t = useT();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Capture phase + stopPropagation: Esc closes only this modal,
      // never a layer underneath (e.g. the template modal behind it).
      e.stopPropagation();
      e.preventDefault();
      onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal"
        role="alertdialog"
        aria-label={title}
        data-testid="confirm-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{title}</h2>
        <p style={{ whiteSpace: 'pre-wrap' }}>{message}</p>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button className="btn secondary" data-testid="confirm-modal-cancel" onClick={onCancel}>
            {t('botForm.cancel')}
          </button>
          <button
            className={danger ? 'btn danger' : 'btn'}
            data-testid="confirm-modal-confirm"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Pending confirm state kept by each view that uses ConfirmModal. */
export interface PendingConfirm {
  title: string;
  message: string;
  confirmLabel: string;
  /** Danger styling for the confirm button. Defaults to true (ConfirmModal's default). */
  danger?: boolean;
  onConfirm: () => void;
  /**
   * Optional action when the modal is cancelled (backdrop, Esc, Cancel
   * button). Most confirms need none — cancel only closes the modal.
   * Used when cancel itself means something, e.g. the L5 vault flow in
   * SettingsView: cancelling the second dialog saves the temporary
   * secrets instead of deleting them.
   */
  onCancel?: () => void;
}
