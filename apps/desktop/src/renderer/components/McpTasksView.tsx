import { useCallback, useEffect, useState } from 'react';
import type { McpTaskStatusView, McpTaskViewLike } from '../types';
import { useT } from '../i18n/useT';

interface Props {
  onBack: () => void;
}

/** Static status -> i18n key map (kept literal so the i18n key scan finds every key). */
const STATUS_KEYS: Record<McpTaskStatusView, string> = {
  working: 'mcpTasks.status.working',
  input_required: 'mcpTasks.status.input_required',
  completed: 'mcpTasks.status.completed',
  failed: 'mcpTasks.status.failed',
  cancelled: 'mcpTasks.status.cancelled',
};

function isActive(task: McpTaskViewLike): boolean {
  return task.status === 'working' || task.status === 'input_required';
}

function formatElapsed(task: McpTaskViewLike, now: number): string {
  const ms = Math.max(0, now - task.createdAt);
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatResult(result: unknown): string {
  if (result === undefined) return '';
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return text.length > 2000 ? `${text.slice(0, 2000)}\n[…]` : text;
}

/**
 * MCP Tasks view (v0.98, wave T6): list long-running MCP tasks across
 * all bot workspaces, with live status, timeout info, and cancel.
 * Refreshes on the `mcp-tasks:changed` push from main and polls every
 * 5s while any task is still active.
 */
export default function McpTasksView({ onBack }: Props) {
  const t = useT();
  const [tasks, setTasks] = useState<McpTaskViewLike[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    if (typeof window.openBot.listMcpTasks !== 'function') {
      setLoading(false);
      return;
    }
    try {
      setTasks(await window.openBot.listMcpTasks());
    } catch (err) {
      setError(t('mcpTasks.cancelFailed', { message: (err as Error).message }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (typeof window.openBot.onMcpTasksChanged !== 'function') return undefined;
    return window.openBot.onMcpTasksChanged((next) => setTasks(next));
  }, []);

  useEffect(() => {
    if (!tasks.some(isActive)) return undefined;
    const timer = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [tasks, refresh]);

  const cancelTask = async (task: McpTaskViewLike) => {
    if (typeof window.openBot.cancelMcpTask !== 'function') return;
    setBusyKey(task.key);
    setError('');
    try {
      await window.openBot.cancelMcpTask(task.workspaceDir, task.key);
      await refresh();
    } catch (err) {
      setError(t('mcpTasks.cancelFailed', { message: (err as Error).message }));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>{t('mcpTasks.title')}</h2>
        <button className="btn secondary" onClick={onBack}>{t('mcp.back')}</button>
      </div>
      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <button className="btn secondary" onClick={() => void refresh()} disabled={loading}>
          {loading ? t('mcpTasks.loading') : t('mcpTasks.refresh')}
        </button>
        <span style={{ color: 'var(--text-dim)' }}>{t('mcpTasks.count', { count: String(tasks.length) })}</span>
      </div>
      {error !== '' && <p className="error">{error}</p>}
      {loading ? (
        <p className="empty">{t('mcpTasks.loading')}</p>
      ) : tasks.length === 0 ? (
        <p className="empty">{t('mcpTasks.empty')}</p>
      ) : (
        <ul className="task-list">
          {tasks.map((task) => (
            <li key={`${task.workspaceDir}:${task.key}`}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong>{task.label}</strong>
                <span className={`badge ${task.status}`}>{t(STATUS_KEYS[task.status])}</span>
              </div>
              <p style={{ margin: '6px 0 0', color: 'var(--text-dim)' }}>
                {t('mcpTasks.server', { name: task.serverName })} ·{' '}
                {t('mcpTasks.method', { name: task.method })} ·{' '}
                {t('mcpTasks.elapsed', { time: formatElapsed(task, now) })} ·{' '}
                {t('mcpTasks.pollInterval', { ms: String(task.pollIntervalMs) })}
              </p>
              <p style={{ margin: '4px 0 0', color: 'var(--text-dim)' }}>
                {task.timeoutMs !== undefined
                  ? t('mcpTasks.timeout', { seconds: String(Math.round(task.timeoutMs / 1000)) })
                  : t('mcpTasks.noTimeout')}
                {task.timedOut ? ` · ${t('mcpTasks.timedOut')}` : ''}
              </p>
              {task.error !== undefined && task.error !== '' && (
                <p style={{ margin: '6px 0 0', color: 'var(--text-dim)' }}>
                  {t('mcpTasks.error', { message: task.error })}
                </p>
              )}
              {task.status === 'completed' && task.result !== undefined && (
                <pre
                  style={{
                    margin: '6px 0 0',
                    padding: 8,
                    background: 'var(--bg-dim)',
                    borderRadius: 6,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {formatResult(task.result)}
                </pre>
              )}
              {isActive(task) && (
                <div className="row" style={{ marginTop: 8 }}>
                  <button
                    className="btn secondary"
                    onClick={() => void cancelTask(task)}
                    disabled={busyKey === task.key}
                  >
                    {t('mcpTasks.cancel')}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
