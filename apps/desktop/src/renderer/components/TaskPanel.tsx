import type { TaskView } from '../types';
import { useT } from '../i18n/useT';

interface Props {
  tasks: TaskView[];
  loading: boolean;
  onRefresh: () => void;
}

export default function TaskPanel({ tasks, loading, onRefresh }: Props) {
  const t = useT();
  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>{t('task.title')}</h2>
        <button className="btn secondary" onClick={onRefresh} disabled={loading}>
          {loading ? t('task.loading') : t('task.refresh')}
        </button>
      </div>
      {tasks.length === 0 && (
        <p className="empty">
          {t('task.emptyLine1')}
          <br />
          {t('task.emptyLine2')}
        </p>
      )}
      <ul className="task-list">
        {tasks.map((task) => (
          <li key={task.id}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong>{task.title}</strong>
              <span className={`badge ${task.status}`}>{t(`task.status.${task.status}`)}</span>
            </div>
            {task.detail && <p style={{ margin: '6px 0 0', color: 'var(--text-dim)' }}>{task.detail}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
