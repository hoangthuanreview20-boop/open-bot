/**
 * Harness entry for tests/ui-planning-v096-renderer.test.mjs.
 *
 * Bundled with esbuild and mounted in a bare Electron window — no
 * main process, no preload. Exposes:
 *   `__mountDashboard()` — the real `DashboardView` with two bots;
 *     `window.openBot` is mocked (usage, harness thread log, memory
 *     status, Composio state, automations) with today's entries, so
 *     the cards show real aggregated numbers.
 *   `__mountPlan()` — the real `PlanView` with two bots; the test
 *     drives the create form through the DOM (native setter +
 *     input event, as React controlled inputs require).
 *   `__lastOpened` — the last bot id opened from the dashboard table.
 *
 * The mock data holds no secret and no real account. The views read
 * the real vi.json through useT (default locale is vi).
 */
import { createRoot, type Root } from 'react-dom/client';
import DashboardView from '../../apps/desktop/src/renderer/components/DashboardView';
import PlanView from '../../apps/desktop/src/renderer/components/PlanView';
import type { BotConfigLike } from '../../apps/desktop/src/renderer/types';

let root: Root | null = null;

const BOTS: BotConfigLike[] = [
  { id: 'bot-a', name: 'Bot A', providerId: 'ollama', model: 'llama3', systemPrompt: '', workspaceDir: '/tmp', autoApprove: false },
  { id: 'bot-b', name: 'Bot B', providerId: 'ollama', model: 'llama3', systemPrompt: '', workspaceDir: '/tmp', autoApprove: false },
];

const noop = () => undefined;

function installMock(): void {
  const nowIso = new Date().toISOString();
  const api: Record<string, unknown> = {
    getUsage: (botId: string) =>
      Promise.resolve({
        today: { inputTokens: 100, outputTokens: 50, costUsd: 0.01, calls: 2, unpricedCalls: 0, percentUsed: null },
        month: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0, unpricedCalls: 0, percentUsed: null },
        total: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0, unpricedCalls: 0, percentUsed: null },
      }),
    getHarnessThreadLog: (query: { threadId: string }) => {
      const entries =
        query.threadId === 'bot-a'
          ? [
              { at: nowIso, botId: 'bot-a', threadId: 'bot-a', kind: 'lifecycle', payload: { phase: 'run-start' } },
              { at: nowIso, botId: 'bot-a', threadId: 'bot-a', kind: 'tool_call', payload: { tool: 'read_file' } },
              { at: nowIso, botId: 'bot-a', threadId: 'bot-a', kind: 'tool_call', payload: { tool: 'read_file' } },
            ]
          : [
              { at: nowIso, botId: 'bot-b', threadId: 'bot-b', kind: 'lifecycle', payload: { phase: 'run-start' } },
              { at: nowIso, botId: 'bot-b', threadId: 'bot-b', kind: 'tool_call', payload: { tool: 'web_search' } },
              { at: nowIso, botId: 'bot-b', threadId: 'bot-b', kind: 'error', payload: {} },
            ];
      return Promise.resolve({ threadId: query.threadId, entries, total: entries.length, offset: 0, limit: 100 });
    },
    getMemoryStatus: (payload: { botId: string }) =>
      Promise.resolve({ total: payload.botId === 'bot-a' ? 5 : 7, embedded: 0, ollamaAvailable: false, embeddingModel: '' }),
    getComposioState: () =>
      Promise.resolve({
        enabled: true,
        keyConfigured: true,
        userIdConfigured: true,
        apps: [
          { toolkit: 'github', label: 'GitHub', icon: '', enabled: true },
          { toolkit: 'gmail', label: 'Gmail', icon: '', enabled: true },
          { toolkit: 'slack', label: 'Slack', icon: '', enabled: false },
        ],
      }),
    listAutomations: () =>
      Promise.resolve([
        { id: 'auto-1', name: 'Morning digest' },
        { id: 'auto-2', name: 'Weekly report' },
        { id: 'auto-3', name: 'Backup' },
      ]),
  };
  (window as unknown as { openBot: unknown }).openBot = api;
}

function mount(node: React.ReactNode): boolean {
  const el = document.getElementById('root');
  if (!el) return false;
  if (root) {
    root.unmount();
    root = null;
  }
  root = createRoot(el);
  root.render(node);
  return true;
}

function mountDashboard(): boolean {
  installMock();
  (window as unknown as { __lastOpened: string | null }).__lastOpened = null;
  return mount(
    <DashboardView
      bots={BOTS}
      onBack={noop}
      onOpenBot={(id) => {
        (window as unknown as { __lastOpened: string | null }).__lastOpened = id;
      }}
      onOpenEventLog={noop}
      onOpenMemory={noop}
      onOpenAutomations={noop}
      onOpenConnectedApps={noop}
    />,
  );
}

function mountPlan(): boolean {
  try {
    localStorage.removeItem('open-bot:plans-v096');
  } catch {
    // Storage unavailable — the view still works in-memory.
  }
  return mount(<PlanView bots={BOTS} onBack={noop} />);
}

// Seed a plan whose running step already repeated the same tool
// call 3x, so the stuck banner shows on mount (tests the
// localStorage round-trip of the tool-call history, not just the
// in-memory detector).
function seedStuckPlan(): boolean {
  try {
    const sig = 'read_file(path="/tmp/x.txt")';
    localStorage.setItem(
      'open-bot:plans-v096',
      JSON.stringify({
        plans: [
          {
            id: 'plan-seed',
            title: 'Seeded plan',
            steps: [{ id: 'step-1', title: 'Loop step', status: 'running', attempts: 1 }],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
        toolHistory: { 'step-1': [sig, sig, sig] },
      }),
    );
    return true;
  } catch {
    return false;
  }
}

function mountSeededPlan(): boolean {
  if (!seedStuckPlan()) return false;
  return mount(<PlanView bots={BOTS} onBack={noop} />);
}

(window as unknown as { __mountDashboard: () => boolean }).__mountDashboard = mountDashboard;
(window as unknown as { __mountPlan: () => boolean }).__mountPlan = mountPlan;
(window as unknown as { __mountSeededPlan: () => boolean }).__mountSeededPlan = mountSeededPlan;
