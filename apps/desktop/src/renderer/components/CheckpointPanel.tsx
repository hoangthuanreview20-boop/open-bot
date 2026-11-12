import { useCallback, useEffect, useState } from 'react';
import type { CheckpointSummaryView } from '../types';
import { useT } from '../i18n/useT';

interface Props {
  botId: string;
  botName?: string;
  onReplayed: (text: string) => void;
}

interface RunGroup {
  runId: string;
  checkpoints: CheckpointSummaryView[];
}

/**
 * Run recovery panel (P1-8): lists a bot's runs that have durable
 * checkpoints (SQLite `run_checkpoints` — survives app restarts) and
 * lets the user resume / time-travel replay from any step. Tool calls
 * already finished are NOT re-executed (they are in the checkpoint's
 * messages); the model just continues from that step's history.
 */
export default function CheckpointPanel({ botId, botName, onReplayed }: Props) {
  const t = useT();
  const [runs, setRuns] = useState<RunGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [replaying, setReplaying] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await window.openBot.listBotCheckpoints(botId);
      setRuns(res.runs);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('checkpoint.loadError'));
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }, [botId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const replay = async (runId: string, stepIndex: number) => {
    const key = `${runId}#${stepIndex}`;
    setReplaying(key);
    setError('');
    try {
      const res = await window.openBot.replayRun(botId, runId, stepIndex);
      onReplayed(res.text);
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('checkpoint.replayError'));
    } finally {
      setReplaying('');
    }
  };

  return (
    <div style={{ padding: '0 20px 12px' }}>
      <div className="row wrap" style={{ marginBottom: 8 }}>
        <strong>{t('checkpoint.title', { bot: botName ?? botId })}</strong>
        <button className="btn secondary" onClick={() => void load()} disabled={loading}>
          {t('checkpoint.refresh')}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {loading && <p className="hint">{t('checkpoint.loading')}</p>}
      {!loading && runs.length === 0 && <p className="hint">{t('checkpoint.empty')}</p>}
      {runs.map((run) => (
        <div key={run.runId} style={{ marginBottom: 10 }}>
          <p style={{ margin: '0 0 4px', fontSize: 12, fontFamily: 'monospace', wordBreak: 'break-all' }}>
            {t('checkpoint.runLabel', { run: run.runId.slice(0, 8) })}
          </p>
          {run.checkpoints.map((cp) => (
            <div key={cp.id} className="row wrap" style={{ marginBottom: 4 }}>
              <span style={{ fontSize: 13 }}>
                {t('checkpoint.stepLine', {
                  step: cp.stepIndex + 1,
                  messages: cp.messageCount,
                  tools: cp.toolCallCount,
                  tokens: cp.tokensUsed,
                })}
              </span>
              <button
                className="btn secondary"
                disabled={replaying !== ''}
                onClick={() => void replay(run.runId, cp.stepIndex)}
              >
                {replaying === `${run.runId}#${cp.stepIndex}` ? t('checkpoint.replaying') : t('checkpoint.resumeFromStep')}
              </button>
            </div>
          ))}
        </div>
      ))}
      <p className="hint" style={{ margin: '4px 0 0' }}>{t('checkpoint.hint')}</p>
    </div>
  );
}
