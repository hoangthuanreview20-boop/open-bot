/**
 * Harness entry for tests/connected-apps-v067b-renderer.test.mjs.
 *
 * Bundled with esbuild (see the test) and mounted in a bare Electron
 * window — no main process, no preload. The harness installs a mocked
 * `window.openBot` before mounting the real `ConnectedAppsView`, so
 * each scenario controls exactly what the two first-load IPC calls
 * (`apps:list`, `composio:get-state`) do:
 *
 *   - 'apps-loading'     — apps:list never settles, Composio loads fine
 *   - 'apps-loaded'      — apps:list answers with two apps
 *   - 'apps-empty'       — apps:list answers with an empty list
 *   - 'apps-error'       — apps:list rejects once, then answers (retry)
 *   - 'composio-loading' — get-state never settles, apps load fine
 *   - 'composio-empty'   — get-state answers null (method not exposed)
 *   - 'composio-error'   — get-state rejects once, then answers (retry)
 *   - 'github-token'     — apps:list answers with the GitHub token app
 *     (not connected); 'apps:set-token' records the pasted PAT and
 *     answers with the app connected; 'apps:disconnect' records the
 *     call and answers with the app not connected again. The recorded
 *     calls are visible on window as __githubTokenCalls /
 *     __githubDisconnectCalls so the test can assert the PAT travelled
 *     exactly once and disconnect was called. The PAT is visibly fake.
 *
 * The mock data holds no secret and no real account: two local apps
 * (authType 'none', so no OAuth buttons render) and one Composio
 * toolkit with the integration disabled.
 *
 * Comments are English only: the i18n test scans TSX files for
 * Vietnamese diacritics, comments included.
 */
import { createRoot, type Root } from 'react-dom/client';
import ConnectedAppsView from '../../apps/desktop/src/renderer/components/ConnectedAppsView';
import type { ConnectedAppView, ComposioStateView } from '../../apps/desktop/src/renderer/types';

export type HarnessScenario =
  | 'apps-loading'
  | 'apps-loaded'
  | 'apps-empty'
  | 'apps-error'
  | 'composio-loading'
  | 'composio-empty'
  | 'composio-error'
  | 'github-token';

const SAMPLE_APPS: ConnectedAppView[] = [
  {
    app: {
      id: 'local-notes',
      label: 'Local Notes',
      description: 'Notes stored on this machine.',
      icon: '📝',
      authType: 'none',
      tools: [{ name: 'notes_read', description: 'Read a note.', needsApproval: false }],
    },
    authStatus: 'local',
    toolCap: 10,
    exposedToolCount: 1,
    cappedOutToolNames: [],
  },
  {
    app: {
      id: 'local-files',
      label: 'Local Files',
      description: 'Files in the workspace.',
      icon: '📁',
      authType: 'none',
      tools: [{ name: 'files_list', description: 'List files.', needsApproval: true }],
    },
    authStatus: 'local',
    toolCap: 10,
    exposedToolCount: 1,
    cappedOutToolNames: [],
  },
];

const SAMPLE_COMPOSIO: ComposioStateView = {
  enabled: false,
  keyConfigured: false,
  apps: [{ toolkit: 'gmail', label: 'Gmail (via Composio)', icon: '📧', enabled: false }],
};

// v0.68b: GitHub token app in both states (same shape as the real
// catalog entry, short tool list). The PAT is never in this data.
const GITHUB_TOOLS: ConnectedAppView['app']['tools'] = [
  { name: 'git_host_connect', description: 'Check the token and list repos.', needsApproval: false },
  { name: 'pr_list', description: 'List pull requests.', needsApproval: false },
  { name: 'pr_create', description: 'Create a pull request.', needsApproval: true },
];
const githubApp = (authStatus: ConnectedAppView['authStatus']): ConnectedAppView => ({
  app: {
    id: 'github',
    label: 'GitHub',
    description: 'Manage GitHub pull requests with a personal access token.',
    icon: '🐙',
    authType: 'token',
    vaultNamespace: 'github',
    vaultKey: 'token',
    tools: GITHUB_TOOLS,
  },
  authStatus,
  toolCap: 10,
  exposedToolCount: 3,
  cappedOutToolNames: [],
});

const neverSettles = (): Promise<never> => new Promise(() => {
  // Intentionally never resolves: the loading state must stay visible.
});

let root: Root | null = null;
let appsCalls = 0;
let composioCalls = 0;
let githubConnected = false;

function installMock(scenario: HarnessScenario): void {
  appsCalls = 0;
  composioCalls = 0;
  githubConnected = false;
  const win = window as unknown as Record<string, unknown>;
  win.__githubTokenCalls = [];
  win.__githubDisconnectCalls = [];
  const listApps = (): Promise<ConnectedAppView[] | null> => {
    appsCalls += 1;
    if (scenario === 'github-token') {
      return Promise.resolve([githubApp(githubConnected ? 'connected' : 'not_connected')]);
    }
    if (scenario === 'apps-loading') return neverSettles();
    if (scenario === 'apps-error' && appsCalls === 1) return Promise.reject(new Error('list failed'));
    if (scenario === 'apps-empty') return Promise.resolve([]);
    return Promise.resolve(SAMPLE_APPS);
  };
  const setToken = (payload: { appId: string; token: string }): Promise<ConnectedAppView[]> => {
    (win.__githubTokenCalls as Array<{ appId: string; token: string }>).push({ ...payload });
    githubConnected = true;
    return Promise.resolve([githubApp('connected')]);
  };
  const disconnectApp = (payload: { appId: string }): Promise<ConnectedAppView[]> => {
    if (scenario === 'github-token') {
      (win.__githubDisconnectCalls as Array<{ appId: string }>).push({ ...payload });
      githubConnected = false;
      return Promise.resolve([githubApp('not_connected')]);
    }
    return Promise.resolve(SAMPLE_APPS);
  };
  const getComposioState = (): Promise<ComposioStateView | null> => {
    composioCalls += 1;
    if (scenario === 'composio-loading') return neverSettles();
    if (scenario === 'composio-error' && composioCalls === 1) return Promise.reject(new Error('state failed'));
    if (scenario === 'composio-empty') return Promise.resolve(null);
    return Promise.resolve(SAMPLE_COMPOSIO);
  };
  const api: Record<string, unknown> = {
    'apps:list': listApps,
    listConnectedApps: listApps,
    'apps:disconnect': disconnectApp,
    disconnectConnectedApp: (appId: string) => disconnectApp({ appId }),
    // v0.68b: GitHub PAT save (both spellings, same mock).
    'apps:set-token': (payload: { appId: string; token: string }) => setToken(payload),
    setConnectedAppToken: (appId: string, token: string) => setToken({ appId, token }),
    'composio:get-state': getComposioState,
    getComposioState,
    'composio:set-enabled': () => Promise.resolve(SAMPLE_COMPOSIO),
    setComposioEnabled: () => Promise.resolve(SAMPLE_COMPOSIO),
    'composio:set-app-enabled': () => Promise.resolve(SAMPLE_COMPOSIO),
    setComposioAppEnabled: () => Promise.resolve(SAMPLE_COMPOSIO),
    'composio:set-key': () => Promise.resolve(SAMPLE_COMPOSIO),
    setComposioKey: () => Promise.resolve(SAMPLE_COMPOSIO),
    'composio:clear-key': () => Promise.resolve(SAMPLE_COMPOSIO),
    clearComposioKey: () => Promise.resolve(SAMPLE_COMPOSIO),
    'auth:oauth-start': () => Promise.resolve({ ok: false, providerId: 'none' }),
    startOAuthLogin: () => Promise.resolve({ ok: false, providerId: 'none' }),
  };
  (window as unknown as { openBot: unknown }).openBot = api;
}

function mount(scenario: HarnessScenario): boolean {
  installMock(scenario);
  const el = document.getElementById('root');
  if (!el) return false;
  if (root) {
    root.unmount();
    root = null;
  }
  root = createRoot(el);
  root.render(<ConnectedAppsView onBack={() => {}} />);
  return true;
}

function unmount(): void {
  if (root) {
    root.unmount();
    root = null;
  }
}

(window as unknown as Record<string, unknown>).__mountConnectedApps = mount;
(window as unknown as Record<string, unknown>).__unmountConnectedApps = unmount;
