import { useMemo, useState } from 'react';
import { useT } from '../i18n/useT';
import {
  countTreeByStatus,
  flattenSubagentTree,
  gradePercent,
  statusLabelKey,
  type SubagentGradeSummary,
  type SubagentTreeViewSnapshot,
  type SubagentTreeViewStatus,
} from './subagentTreeUtils';

interface Props {
  /** Nested subagent snapshot (host maps the core snapshot into this shape). */
  snapshot: SubagentTreeViewSnapshot | null;
  /** Grader summaries keyed by node id (from a fan-out run). */
  grades?: Record<string, SubagentGradeSummary>;
}

const STATUS_COLORS: Record<SubagentTreeViewStatus, string> = {
  running: '#2f81f7',
  done: '#3fb950',
  error: '#f85149',
  timeout: '#d29922',
  stopped: '#8b949e',
};

/**
 * Nested subagent tree (v1.01, Team T6): renders the spawn tree of a
 * run — one row per node with depth indent, status badge, token usage,
 * model, and the rubric grade when one exists. Nodes can be collapsed.
 * Over-budget nodes and a blown total budget are flagged, never hidden.
 * All display strings go through t() (no hard-coded locale strings).
 */
export default function SubagentTreeView({ snapshot, grades = {} }: Props) {
  const t = useT();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const counts = useMemo(
    () => (snapshot ? countTreeByStatus(snapshot) : null),
    [snapshot],
  );
  const rows = useMemo(
    () => (snapshot ? flattenSubagentTree(snapshot, collapsed) : []),
    [snapshot, collapsed],
  );
  const visibleRows = rows.filter((r) => !r.hidden);

  if (!snapshot) {
    return (
      <div className="subagent-tree">
        <h3>{t('subagentTree.title')}</h3>
        <p>{t('subagentTree.empty')}</p>
      </div>
    );
  }

  const toggle = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="subagent-tree">
      <h3>{t('subagentTree.title')}</h3>
      <p>
        {t('subagentTree.nodes', { count: snapshot.totalNodes })}
        {' · '}
        {t('subagentTree.tokens', { used: snapshot.totalTokensUsed, budget: snapshot.totalBudgetTokens })}
        {' · '}
        {t('subagentTree.maxDepth', { max: snapshot.policy.maxDepth })}
      </p>
      {counts && (
        <p>
          {t('subagentTree.status.running')}: {counts.running}
          {' · '}
          {t('subagentTree.status.done')}: {counts.done}
          {' · '}
          {t('subagentTree.status.error')}: {counts.error}
          {' · '}
          {t('subagentTree.status.timeout')}: {counts.timeout}
          {' · '}
          {t('subagentTree.status.stopped')}: {counts.stopped}
        </p>
      )}
      {snapshot.totalOverBudget && (
        <p role="alert">{t('subagentTree.totalOverBudget')}</p>
      )}
      <ul style={{ listStyle: 'none', paddingLeft: 0 }}>
        {visibleRows.map(({ node, depth }) => {
          const grade = grades[node.id];
          const hasChildren = node.children.length > 0;
          const isCollapsed = collapsed.has(node.id);
          return (
            <li key={node.id} style={{ paddingLeft: depth * 20 }}>
              <div>
                {hasChildren && (
                  <button type="button" onClick={() => toggle(node.id)}>
                    {isCollapsed ? t('subagentTree.expand') : t('subagentTree.collapse')}
                  </button>
                )}{' '}
                <span
                  style={{
                    display: 'inline-block',
                    padding: '0 6px',
                    borderRadius: 4,
                    color: '#fff',
                    backgroundColor: STATUS_COLORS[node.status],
                  }}
                >
                  {t(statusLabelKey(node.status))}
                </span>{' '}
                <strong>{node.name}</strong>{' '}
                <span>
                  {t('subagentTree.depth', { depth: node.depth })}
                  {' · '}
                  {t('subagentTree.tokens', { used: node.tokensUsed, budget: node.budgetTokens })}
                  {' · '}
                  {t('subagentTree.spawns', { count: node.spawnsUsed })}
                </span>
                {node.model && <span> · {t('subagentTree.model', { model: node.model })}</span>}
                {grade && (
                  <span
                    style={{
                      display: 'inline-block',
                      marginLeft: 6,
                      padding: '0 6px',
                      borderRadius: 4,
                      backgroundColor: grade.passed ? '#3fb950' : '#f85149',
                      color: '#fff',
                    }}
                  >
                    {grade.passed
                      ? t('grader.passed', { score: gradePercent(grade) })
                      : t('grader.failed', { score: gradePercent(grade) })}
                    {' · '}
                    {t('grader.rounds', { count: grade.roundsUsed })}
                  </span>
                )}
                {node.overBudget && (
                  <span role="alert"> ⚠️ {t('subagentTree.overBudget')}</span>
                )}
              </div>
              {node.task && (
                <div>
                  {t('subagentTree.task')}: {node.task.split('\n')[0]}
                </div>
              )}
              {node.error && <div>{node.error}</div>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
