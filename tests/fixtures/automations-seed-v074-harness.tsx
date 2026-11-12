/**
 * Harness entry for tests/automations-seed-samples-v074-renderer.test.mjs.
 *
 * Bundled with esbuild and mounted in a bare Electron window — no
 * main process, no preload. `__mountAutomations(scenario)` mounts the
 * real `AutomationsView` with a mocked `window.openBot` whose
 * `seedSampleAutomations` either seeds 4 sample automations into the
 * mocked store (and the next `listAutomations` returns them) or
 * rejects, so the test can check the button, the seeded list and the
 * success/error message the view shows.
 *
 * Scenarios:
 *   ok             empty store; seed appends the 4 samples.
 *   already-seeded store already holds the 4 samples; seed returns
 *                  { created: [], skipped: [4 ids] }.
 *   seed-fails     seedSampleAutomations rejects with 'seed boom'.
 *
 * The mock data holds no secret and no real account. The view reads
 * the real vi.json through useT (default locale is vi), so
 * assertions check the real Vietnamese strings.
 */
import { createRoot, type Root } from 'react-dom/client';
import AutomationsView from '../../apps/desktop/src/renderer/components/AutomationsView';
import type { AutomationLike, BotConfigLike } from '../../apps/desktop/src/renderer/types';

let root: Root | null = null;

const BOTS: BotConfigLike[] = [
  { id: 'bot-a', name: 'Bot A', providerId: 'ollama', model: 'llama3', systemPrompt: '', workspaceDir: '/tmp', autoApprove: false },
];

const SAMPLES: AutomationLike[] = [
  { id: 'morning-brief-auto', botId: '', name: 'Morning brief (auto)', trigger: { kind: 'interval', minutes: 480 }, action: { kind: 'run-agent', botId: '', prompt: 'Summarise the morning news.' }, enabled: true },
  { id: 'weekly-report-auto', botId: '', name: 'Weekly report (auto)', trigger: { kind: 'cron', expression: '0 9 * * 1' }, action: { kind: 'run-agent', botId: '', prompt: 'Summarise this week.' }, enabled: true },
  { id: 'notes-changed-index', botId: '', name: 'Notes changed — update index', trigger: { kind: 'event', event: 'file-changed', pathPattern: 'notes/*.md' }, action: { kind: 'run-agent', botId: '', prompt: 'Update the notes index.' }, enabled: true },
  { id: 'agent-done-notify', botId: '', name: 'Agent finished — notify', trigger: { kind: 'event', event: 'agent-done' }, action: { kind: 'notify', message: 'A bot finished a job.' }, enabled: true },
];

let store: AutomationLike[] = [];

function installMock(scenario: string): void {
  store = scenario === 'already-seeded' ? SAMPLES.map((s) => ({ ...s })) : [];
  const api: Record<string, unknown> = {
    listAutomations: () => Promise.resolve(store.map((a) => ({ ...a }))),
    listAutomationRuns: () => Promise.resolve([]),
    hasAutomationWebhookKey: () => Promise.resolve(false),
    onAutomationRunsChanged: () => () => undefined,
    seedSampleAutomations: () => {
      if (scenario === 'seed-fails') return Promise.reject(new Error('seed boom'));
      const missing = SAMPLES.filter((s) => !store.some((a) => a.id === s.id));
      const created = missing.map((s) => ({ ...s }));
      store = [...store, ...created];
      return Promise.resolve({
        created: created.map((a) => ({ ...a })),
        skipped: SAMPLES.filter((s) => !missing.includes(s)).map((s) => s.id),
      });
    },
  };
  (window as unknown as { openBot: unknown }).openBot = api;
}

function mountAutomations(scenario: string): boolean {
  installMock(scenario);
  const el = document.getElementById('root');
  if (!el) return false;
  if (root) {
    root.unmount();
    root = null;
  }
  root = createRoot(el);
  root.render(<AutomationsView bots={BOTS} botId="bot-a" onBack={() => undefined} />);
  return true;
}

(window as unknown as { __mountAutomations: (s: string) => boolean }).__mountAutomations = mountAutomations;
