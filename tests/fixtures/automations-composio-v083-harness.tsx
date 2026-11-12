/**
 * Harness entry for tests/automations-composio-v083-renderer.test.mjs.
 *
 * Bundled with esbuild and mounted in a bare Electron window — no
 * main process, no preload. `__mountAutomations(scenario)` mounts the
 * real `AutomationsView` with a mocked `window.openBot` that records
 * every Composio IPC call in `window.__composioCalls` (secrets set,
 * tokens created, test events delivered) so the test can assert the
 * UI drove the right calls without any real Vault or Composio.
 *
 * Scenarios:
 *   empty         no automations; the test creates one from the form.
 *   with-composio one composio automation WITHOUT a secret; the test
 *                 pastes the secret on the row, creates a URL token
 *                 and sends a test event.
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

const DEFS = [
  { toolkit: 'gmail', slug: 'GMAIL_NEW_MESSAGE', name: 'New message', delivery: 'webhook' },
  { toolkit: 'github', slug: 'GITHUB_ISSUE_CREATED', name: 'Issue created', delivery: 'webhook' },
];

const COMPOSIO_AUTO: AutomationLike = {
  id: 'comp-1',
  botId: 'bot-a',
  name: 'Mail mới → báo',
  trigger: { kind: 'composio', triggerSlug: 'GMAIL_NEW_MESSAGE', keyId: 'comp-1' },
  action: { kind: 'notify', message: 'Có mail mới' },
  enabled: true,
};

let store: AutomationLike[] = [];
let runs: Array<{ id: string; automationId: string; status: string; startedAt: string }> = [];

const calls = {
  secrets: {} as Record<string, string>,
  deletedSecrets: [] as string[],
  tokens: {} as Record<string, string>,
  tests: [] as string[],
};

function installMock(scenario: string): void {
  store = scenario === 'with-composio' ? [{ ...COMPOSIO_AUTO }] : [];
  runs = [];
  calls.secrets = {};
  calls.deletedSecrets = [];
  calls.tokens = {};
  calls.tests = [];
  const api: Record<string, unknown> = {
    listAutomations: () => Promise.resolve(store.map((a) => ({ ...a }))),
    listAutomationRuns: () => Promise.resolve(runs.map((r) => ({ ...r }))),
    hasAutomationWebhookKey: () => Promise.resolve(false),
    onAutomationRunsChanged: () => () => undefined,
    seedSampleAutomations: () => Promise.resolve({ created: [], skipped: [] }),
    createAutomation: (payload: Record<string, unknown>) => {
      const created = { ...(payload as unknown as AutomationLike) };
      store = [...store, created];
      return Promise.resolve({ ...created });
    },
    updateAutomation: (a: AutomationLike) => Promise.resolve({ ...a }),
    deleteAutomation: (id: string) => {
      store = store.filter((a) => a.id !== id);
      return Promise.resolve(true);
    },
    setAutomationEnabled: (id: string, enabled: boolean) => {
      const found = store.find((a) => a.id === id);
      if (found) found.enabled = enabled;
      return Promise.resolve(found ? { ...found } : null);
    },
    runAutomationNow: () => Promise.resolve(null),
    retryAutomationRun: () => Promise.resolve(null),
    retryLastFailedAutomationRun: () => Promise.resolve(null),
    // --- v0.83b: Composio trigger mocks ---
    listComposioTriggerDefs: () => Promise.resolve(DEFS.map((d) => ({ ...d }))),
    setComposioTriggerSecret: (id: string, secret: string) => {
      calls.secrets[id] = secret;
      return Promise.resolve({ ok: true });
    },
    hasComposioTriggerSecret: (id: string) => Promise.resolve(id in calls.secrets),
    deleteComposioTriggerSecret: (id: string) => {
      delete calls.secrets[id];
      calls.deletedSecrets.push(id);
      return Promise.resolve(true);
    },
    createComposioTriggerToken: (id: string) => {
      calls.tokens[id] = 'tok-test-123';
      return Promise.resolve({ keyId: `${id}-url-token`, secret: 'tok-test-123' });
    },
    rotateComposioTriggerToken: (id: string) => {
      calls.tokens[id] = 'tok-test-456';
      return Promise.resolve({ keyId: `${id}-url-token`, secret: 'tok-test-456' });
    },
    hasComposioTriggerToken: (id: string) => Promise.resolve(id in calls.tokens),
    deleteComposioTriggerToken: (id: string) => {
      delete calls.tokens[id];
      return Promise.resolve(true);
    },
    testComposioTrigger: (id: string) => {
      calls.tests.push(id);
      runs = [...runs, { id: `run-${Date.now()}`, automationId: id, status: 'ok', startedAt: new Date().toISOString() }];
      return Promise.resolve({ ok: true });
    },
  };
  (window as unknown as { openBot: unknown }).openBot = api;
  (window as unknown as { __composioCalls: unknown }).__composioCalls = calls;
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
