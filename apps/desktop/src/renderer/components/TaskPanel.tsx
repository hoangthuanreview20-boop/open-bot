import type { TaskView } from '../types';

interface Props {
  tasks: TaskView[];
  loading: boolean;
  onRefresh: () => void;
}

const STATUS_LABEL: Record<TaskView['status'], string> = {
  pending: 'Chờ chạy',
  running: 'Đang chạy',
  done: 'Hoàn thành',
  failed: 'Thất bại',
};

export default function TaskPanel({ tasks, loading, onRefresh }: Props) {
  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>Nhiệm vụ &amp; routine của bot</h2>
        <button className="btn secondary" onClick={onRefresh} disabled={loading}>
          {loading ? 'Đang tải…' : 'Làm mới'}
        </button>
      </div>
      {tasks.length === 0 && (
        <p className="empty">
          Bot này chưa có nhiệm vụ hay routine nào.
          <br />
          Nhiệm vụ lặp lại (routine) sẽ được quản lý tại đây khi packages/core hỗ trợ.
        </p>
      )}
      <ul className="task-list">
        {tasks.map((t) => (
          <li key={t.id}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong>{t.title}</strong>
              <span className={`badge ${t.status}`}>{STATUS_LABEL[t.status]}</span>
            </div>
            {t.detail && <p style={{ margin: '6px 0 0', color: 'var(--text-dim)' }}>{t.detail}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
