/**
 * Harness entry for tests/plan-diff-v079-renderer.test.mjs.
 *
 * Bundled with esbuild and mounted in a bare Electron window — no
 * main process, no preload. `__mountPlanDiff(scenario)` mounts the
 * real `PlanReviewView` with no session plans and a mocked
 * `window.openBot['plans:list']` returning one stored plan, so the
 * test can check the "what changed since the previous version" diff
 * section (v0.79b).
 *
 * Scenarios:
 *   with-diff  stored plan carries a diff (2 steps added, 2 removed).
 *   no-diff    stored plan carries no diff (never rewritten).
 *
 * The mock data holds no secret and no real account. The view reads
 * the real vi.json through useT (default locale is vi), so assertions
 * check the real Vietnamese strings.
 */
import { createRoot, type Root } from 'react-dom/client';
import PlanReviewView from '../../apps/desktop/src/renderer/components/PlanReviewView';

let root: Root | null = null;

const BASE_PLAN = {
  projectId: 'proj-1',
  botId: 'bot-1',
  title: 'Kế hoạch A',
  detail: 'Mô tả v2',
  filePath: '/tmp/ws/.open-bot/plans/proj-1.md',
  path: '/tmp/ws/.open-bot/plans/proj-1.md',
  steps: ['Bước một', 'Bước hai sửa', 'Bước bốn'],
  decisions: ['Chọn X', 'Chọn Z'],
  status: 'pending' as const,
  createdAt: '2026-11-11T00:00:00.000Z',
  updatedAt: '2026-11-11T01:00:00.000Z',
};

const DIFF = {
  steps: {
    added: ['Bước hai sửa', 'Bước bốn'],
    removed: ['Bước hai', 'Bước ba'],
    unchanged: ['Bước một'],
  },
  decisions: { added: ['Chọn Z'], removed: ['Chọn Y'], unchanged: ['Chọn X'] },
};

function installMock(scenario: string): void {
  const plan = scenario === 'with-diff' ? { ...BASE_PLAN, diff: DIFF } : { ...BASE_PLAN };
  const api: Record<string, unknown> = {
    'plans:list': () => Promise.resolve([plan]),
  };
  (window as unknown as { openBot: unknown }).openBot = api;
}

function mountPlanDiff(scenario: string): boolean {
  installMock(scenario);
  const el = document.getElementById('root');
  if (!el) return false;
  if (root) {
    root.unmount();
    root = null;
  }
  root = createRoot(el);
  root.render(
    <PlanReviewView
      plans={[]}
      botName="Bot A"
      botId="bot-1"
      onBack={() => undefined}
      onApprove={() => Promise.resolve()}
      onReject={() => Promise.resolve()}
      onRequestChanges={() => Promise.resolve()}
    />,
  );
  return true;
}

(window as unknown as { __mountPlanDiff: (s: string) => boolean }).__mountPlanDiff = mountPlanDiff;
