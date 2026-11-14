/**
 * Pure helpers for SubagentTreeView (v1.01, Team T6).
 *
 * Kept in a plain `.ts` file (no JSX) so node tests can import it via
 * type stripping, mirroring the `aguiFeed.ts` pattern. The view-model
 * types below mirror `SubagentTreeSnapshot` from `@open-bot/core`
 * (`subagents/nested.ts`) field-for-field, but live here so the
 * renderer stays self-contained (see renderer/types.ts header note:
 * no import from @open-bot/core). The host maps a core snapshot into
 * this shape before passing it to the component.
 */

export type SubagentTreeViewStatus = 'running' | 'done' | 'error' | 'timeout' | 'stopped';

export interface SubagentTreeViewNode {
  id: string;
  parentId: string | null;
  name: string;
  depth: number;
  status: SubagentTreeViewStatus;
  task: string;
  model?: string;
  tools?: string[];
  tokensUsed: number;
  /** Per-node context budget (see core SubagentNode.budgetTokens). */
  budgetTokens: number;
  spawnsUsed: number;
  startedAt: number;
  endedAt?: number;
  error?: string;
  overBudget: boolean;
  children: SubagentTreeViewNode[];
}

export interface SubagentTreeViewSnapshot {
  root: SubagentTreeViewNode;
  totalNodes: number;
  totalTokensUsed: number;
  totalBudgetTokens: number;
  totalOverBudget: boolean;
  policy: {
    maxDepth: number;
    maxSpawnsPerRoot: number;
    maxSpawnsPerBranch: number;
  };
}

/** Grader summary for one node, keyed by node id in the component props. */
export interface SubagentGradeSummary {
  /** Score ratio 0..1 from the rubric grader. */
  ratio: number;
  passed: boolean;
  roundsUsed: number;
}

export interface FlattenedTreeRow {
  node: SubagentTreeViewNode;
  depth: number;
  /** True when any ancestor is collapsed (row hidden in the flat view). */
  hidden: boolean;
}

/** Count nodes by status across the whole tree (for the header summary). */
export function countTreeByStatus(snapshot: SubagentTreeViewSnapshot): Record<SubagentTreeViewStatus, number> {
  const counts: Record<SubagentTreeViewStatus, number> = {
    running: 0,
    done: 0,
    error: 0,
    timeout: 0,
    stopped: 0,
  };
  const walk = (node: SubagentTreeViewNode): void => {
    counts[node.status] += 1;
    for (const child of node.children) walk(child);
  };
  walk(snapshot.root);
  return counts;
}

/**
 * Flatten the tree depth-first into rows. `collapsedIds` hides the
 * descendants of collapsed nodes (the collapsed node itself stays
 * visible). Pure — the component keeps the collapsed set in state.
 */
export function flattenSubagentTree(
  snapshot: SubagentTreeViewSnapshot,
  collapsedIds: ReadonlySet<string> = new Set(),
): FlattenedTreeRow[] {
  const rows: FlattenedTreeRow[] = [];
  const walk = (node: SubagentTreeViewNode, hidden: boolean): void => {
    rows.push({ node, depth: node.depth, hidden });
    const hideChildren = hidden || collapsedIds.has(node.id);
    for (const child of node.children) walk(child, hideChildren);
  };
  walk(snapshot.root, false);
  return rows;
}

/** i18n key for a node status badge (resolved by the component via t()). */
export function statusLabelKey(status: SubagentTreeViewStatus): string {
  return `subagentTree.status.${status}`;
}

/** Whole percent (0..100) for a grade ratio, clamped for display. */
export function gradePercent(grade: SubagentGradeSummary): number {
  if (!Number.isFinite(grade.ratio)) return 0;
  return Math.min(100, Math.max(0, Math.round(grade.ratio * 100)));
}
