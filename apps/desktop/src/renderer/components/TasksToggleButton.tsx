import { useT } from '../i18n/useT';

interface Props {
  showTasks: boolean;
  /** How many tasks of the selected bot are currently running. */
  runningCount: number;
  onToggle: () => void;
}

/**
 * v0.77 (UI parity §3.7): the Tasks panel toggle with a badge counting
 * running tasks. The panel itself already badges each row
 * (`TaskPanel.tsx`), but the toggle was silent while tasks ran in the
 * background — a bot running a routine looked idle from the chat view.
 * The badge only shows while something is actually running (0 = hidden).
 */
export default function TasksToggleButton({ showTasks, runningCount, onToggle }: Props) {
  const t = useT();
  return (
    <button className="btn secondary" data-testid="tasks-toggle" onClick={onToggle}>
      {showTasks ? t('app.hideTasks') : t('app.showTasks')}
      {runningCount > 0 && (
        <span
          className="badge running"
          data-testid="tasks-running-badge"
          title={t('app.runningTasks', { count: String(runningCount) })}
        >
          {runningCount}
        </span>
      )}
    </button>
  );
}
