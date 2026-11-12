import type {
  ApprovalRequest,
  HarnessPermissionRequestView,
  InterruptDecisionView,
  InterruptRequestView,
} from '../types';
import { useT } from '../i18n/useT';
import ApprovalCard from './ApprovalCard';
import PermissionCard from './PermissionCard';
import InterruptCard from './InterruptCard';

interface Props {
  approvals: ApprovalRequest[];
  harnessPermissions: HarnessPermissionRequestView[];
  interrupts: InterruptRequestView[];
  /** Display name of a bot (App looks it up from the bot list). */
  botName: (botId: string) => string | undefined;
  onRespondApproval: (
    callId: string,
    approved: boolean,
    args?: Record<string, unknown>,
    allowAlways?: boolean,
  ) => void;
  onRespondPermission: (requestId: string, allowed: boolean) => void;
  onRespondInterrupt: (requestId: string, decision: InterruptDecisionView) => void;
  /** Switch the chat to the card's bot so the user answers in context. */
  onJumpToBot: (botId: string) => void;
  onClose: () => void;
}

/**
 * Approval tray (UI-9): the separate home for every decision card —
 * tool approvals, CLI-engine permissions and run interrupts — from ALL
 * bots, instead of piling them under the open chat (the v0.50 layout
 * the parity review flagged as C7: a card from another bot sat under
 * the wrong bot's chat and was easy to answer in the wrong context).
 *
 * App keeps the lists alive across bot switches (no clearing on
 * switch — the old M8 loss shape), renders this tray as a right-hand
 * dock column visible in every view, and auto-opens it when the first
 * card arrives. Each card names its bot and offers a jump to that
 * bot's chat; the sidebar badge shows the same pending count per bot.
 */
export default function ApprovalTray({
  approvals,
  harnessPermissions,
  interrupts,
  botName,
  onRespondApproval,
  onRespondPermission,
  onRespondInterrupt,
  onJumpToBot,
  onClose,
}: Props) {
  const t = useT();
  const total = approvals.length + harnessPermissions.length + interrupts.length;
  return (
    <aside className="approval-tray" data-testid="approval-tray" aria-label={t('approval.trayTitle')}>
      <div className="approval-tray-head">
        <h2>
          {t('approval.trayTitle')}{' '}
          <span className="badge approval" data-testid="approval-tray-count">
            {total}
          </span>
        </h2>
        <button
          className="btn secondary"
          data-testid="approval-tray-close"
          onClick={onClose}
          title={t('approval.trayClose')}
          aria-label={t('approval.trayClose')}
        >
          ✕
        </button>
      </div>
      {total === 0 && <p className="empty">{t('approval.trayEmpty')}</p>}
      {approvals.map((a) => (
        <div key={a.callId} className="approval-tray-item" data-bot-id={a.botId}>
          <button className="btn secondary" onClick={() => onJumpToBot(a.botId)}>
            {t('approval.trayOpenBot', { bot: botName(a.botId) ?? a.botId })}
          </button>
          <ApprovalCard approval={a} botName={botName(a.botId)} onRespond={onRespondApproval} />
        </div>
      ))}
      {harnessPermissions.map((p) => (
        <div key={p.requestId} className="approval-tray-item" data-bot-id={p.botId}>
          <button className="btn secondary" onClick={() => onJumpToBot(p.botId)}>
            {t('approval.trayOpenBot', { bot: botName(p.botId) ?? p.botId })}
          </button>
          <PermissionCard request={p} botName={botName(p.botId)} onRespond={onRespondPermission} />
        </div>
      ))}
      {interrupts.map((r) => (
        <div key={r.requestId} className="approval-tray-item" data-bot-id={r.botId}>
          <button className="btn secondary" onClick={() => onJumpToBot(r.botId)}>
            {t('approval.trayOpenBot', { bot: botName(r.botId) ?? r.botId })}
          </button>
          <InterruptCard request={r} botName={botName(r.botId)} onRespond={onRespondInterrupt} />
        </div>
      ))}
    </aside>
  );
}
