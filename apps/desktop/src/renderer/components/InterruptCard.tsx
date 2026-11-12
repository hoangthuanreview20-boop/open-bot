import { useState } from 'react';
import type { InterruptDecisionView, InterruptRequestView } from '../types';
import { useT } from '../i18n/useT';

interface Props {
  request: InterruptRequestView;
  /** Display name of the bot (App looks it up from the bot list). */
  botName?: string;
  onRespond: (requestId: string, decision: InterruptDecisionView) => void;
}

/**
 * In-chat interrupt card (P1-8): a run paused at a safe point (step
 * boundary, or just before a tool call) to ask the user — human-in-the-
 * loop for long runs, generalizing the 1-step plan approval. The run
 * already saved a checkpoint of the last completed step, so any answer
 * resumes from exactly there:
 *  - Continue: run resumes at the same step.
 *  - Reply + continue: the answer is pushed as a user message first.
 *  - Deny this tool (only at a before-tool stop): the tool is refused,
 *    the run continues with the denial in history.
 *  - Cancel run: the run stops (checkpoint kept, resumable later).
 * No answer within 10 minutes → the coordinator treats it as cancel.
 */
export default function InterruptCard({ request, botName, onRespond }: Props) {
  const t = useT();
  const [answer, setAnswer] = useState('');
  const [showReply, setShowReply] = useState(false);
  const toolName = request.toolCall?.name ?? '';
  const botLabel = botName ?? request.botId;

  return (
    <div className="approval" role="alert">
      <h3>{t('interrupt.title')}</h3>
      <p style={{ margin: '0 0 4px' }}>
        {t('interrupt.requestLine', { bot: botLabel, step: request.stepIndex + 1 })}
      </p>
      {request.question && <p className="hint" style={{ margin: '0 0 6px' }}>{request.question}</p>}
      {toolName && (
        <p style={{ margin: '0 0 10px', fontSize: 12, fontFamily: 'monospace', wordBreak: 'break-all' }}>
          <strong>{t('interrupt.toolLabel')}: </strong>
          {toolName}
        </p>
      )}
      <div className="row wrap">
        <button className="btn ok" onClick={() => onRespond(request.requestId, { action: 'continue' })}>
          {t('interrupt.continue')}
        </button>
        <button className="btn" onClick={() => setShowReply((v) => !v)}>
          {t('interrupt.replyAndContinue')}
        </button>
        {toolName && (
          <button
            className="btn danger"
            onClick={() => onRespond(request.requestId, { action: 'deny-tool' })}
          >
            {t('interrupt.denyTool')}
          </button>
        )}
        <button className="btn secondary" onClick={() => onRespond(request.requestId, { action: 'cancel' })}>
          {t('interrupt.cancelRun')}
        </button>
      </div>
      {showReply && (
        <div style={{ marginTop: 10 }}>
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            rows={3}
            placeholder={t('interrupt.replyPlaceholder')}
            style={{ width: '100%', boxSizing: 'border-box', fontSize: 13, margin: '0 0 10px' }}
          />
          <button
            className="btn"
            disabled={!answer.trim()}
            onClick={() => onRespond(request.requestId, { action: 'continue-with-message', message: answer.trim() })}
          >
            {t('interrupt.sendReply')}
          </button>
        </div>
      )}
      <p className="hint" style={{ margin: '8px 0 0' }}>{t('interrupt.timeoutHint')}</p>
    </div>
  );
}
