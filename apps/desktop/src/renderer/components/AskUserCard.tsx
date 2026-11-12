import { useState } from 'react';
import type { AskUserRequest } from '../types';
import { useT } from '../i18n/useT';

interface Props {
  request: AskUserRequest;
  onRespond: (requestId: string, answer: string) => void;
}

/**
 * Question card shown when the agent runs the ask_user tool: the agent
 * waits for the user's answer before continuing its turn.
 */
export default function AskUserCard({ request, onRespond }: Props) {
  const t = useT();
  const [answer, setAnswer] = useState('');

  const submit = (value: string) => {
    onRespond(request.requestId, value);
  };

  return (
    <div className="approval" role="alert">
      <h3>❓ {t('askUser.title')}</h3>
      <p style={{ margin: '0 0 8px' }}>{request.question}</p>
      {request.options && request.options.length > 0 && (
        <div className="row wrap" style={{ marginBottom: 8 }}>
          {request.options.map((opt) => (
            <button key={opt} className="btn secondary" onClick={() => submit(opt)}>
              {opt}
            </button>
          ))}
        </div>
      )}
      <div className="row">
        <div style={{ flex: 1, minWidth: 0 }}>
          <input
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit(answer);
            }}
            placeholder={t('askUser.answerPlaceholder')}
          />
        </div>
        <button className="btn" onClick={() => submit(answer)} disabled={!answer.trim()}>
          {t('askUser.send')}
        </button>
        <button className="btn secondary" onClick={() => submit('')}>
          {t('askUser.skip')}
        </button>
      </div>
    </div>
  );
}
