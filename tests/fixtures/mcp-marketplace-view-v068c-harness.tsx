/**
 * Harness entry for tests/mcp-marketplace-view-v068c-renderer.test.mjs.
 *
 * Bundled with esbuild (see the test) and mounted in a bare Electron
 * window — no main process, no preload. The harness installs a mocked
 * `window.openBot` before mounting the real `McpMarketplaceView`, so
 * each scenario controls exactly what the first-load IPC calls
 * (`listMcpMarketplace`, `listMcpInstalled`) do:
 *
 *   - 'loading' — listMcpMarketplace never settles, installed loads fine
 *   - 'loaded'  — the marketplace answers with two servers
 *   - 'error'   — listMcpMarketplace rejects once, then answers (retry)
 *   - 'probe-warning' — like 'loaded', but probing a server answers
 *     ok + no tools + a -32602 warning (v0.73: the view must show
 *     the warning next to the empty list instead of looking like
 *     a server with no tools).
 *
 * The mock data holds no secret and no real server: two local catalogue
 * entries with fake commands that are never executed (the view only
 * probes a server when the user clicks "View tools", which no scenario
 * does — the probe stubs below answer with an empty tool list).
 *
 * Comments are English only: the i18n test scans TSX files for
 * Vietnamese diacritics, comments included.
 */
import { createRoot, type Root } from 'react-dom/client';
import McpMarketplaceView from '../../apps/desktop/src/renderer/components/McpMarketplaceView';
import type {
  McpMarketplaceServerLike,
  McpServerConfigLike,
} from '../../apps/desktop/src/renderer/types';

export type HarnessScenario = 'loading' | 'loaded' | 'error' | 'probe-warning';

const SAMPLE_SERVERS: McpMarketplaceServerLike[] = [
  {
    id: 'fake-tools',
    name: 'Fake Tools',
    description: 'Fake MCP server for the marketplace test.',
    transport: 'stdio',
    command: 'node',
    args: ['fake-server.mjs'],
    tags: ['test'],
  },
  {
    id: 'memory',
    name: 'Memory',
    description: 'A persistent knowledge graph the agent can remember facts in.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    tags: ['memory', 'official'],
  },
];

const neverSettles = (): Promise<never> => new Promise(() => {
  // Intentionally never resolves: the loading state must stay visible.
});

let root: Root | null = null;
let listCalls = 0;

function installMock(scenario: HarnessScenario): void {
  listCalls = 0;
  const win = window as unknown as Record<string, unknown>;
  win.__backClicked = false;
  // v0.84e: every installMcpServer call is recorded (id, botId, args)
  // so the renderer test can prove edited args reach the IPC.
  const installCalls: Array<{ id: string; botId: string; args?: string[] }> = [];
  win.__installCalls = installCalls;
  // v0.90 (Marketplace v2): doInstall records the approval BEFORE the
  // install IPC — the mock must expose approveMarketplace or the
  // install throws "not a function" and no install call ever happens.
  const approveCalls: Array<{ kind: string; id: string; version?: string; source?: string }> = [];
  win.__approveCalls = approveCalls;
  const listMarketplace = (): Promise<McpMarketplaceServerLike[]> => {
    listCalls += 1;
    if (scenario === 'loading') return neverSettles();
    if (scenario === 'error' && listCalls === 1) return Promise.reject(new Error('list failed'));
    return Promise.resolve(SAMPLE_SERVERS);
  };
  const api: Record<string, unknown> = {
    listMcpMarketplace: listMarketplace,
    listMcpInstalled: (_botId: string): Promise<McpServerConfigLike[]> => Promise.resolve([]),
    listMcpServerTools: (id: string) =>
      scenario === 'probe-warning'
        ? Promise.resolve({
            serverId: id,
            status: 'ok',
            tools: [],
            truncated: false,
            warnings: [
              {
                method: 'tools/list',
                code: -32602,
                message:
                  'MCP server "fake-tools" rejected tools/list (invalid params, code -32602): Invalid params: tools/list requires a cursor',
                detail: 'Invalid params: tools/list requires a cursor',
              },
            ],
          })
        : Promise.resolve({ serverId: id, status: 'ok', tools: [], truncated: false }),
    installMcpServer: (id: string, botId: string, args?: string[]) => {
      installCalls.push({ id, botId, args });
      return Promise.resolve({
        server: SAMPLE_SERVERS.find((s) => s.id === id) ?? SAMPLE_SERVERS[0],
        config: { name: id, args },
        nextSteps: [],
      });
    },
    uninstallMcpServer: (id: string, _botId: string) =>
      Promise.resolve({ name: id }),
    // v0.90 (Marketplace v2): approval gate for install/update.
    approveMarketplace: (kind: string, id: string, version?: string, source?: string) => {
      approveCalls.push({ kind, id, version, source });
      return Promise.resolve(undefined);
    },
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
  root.render(
    <McpMarketplaceView
      botId="bot-1"
      onBack={() => {
        (window as unknown as Record<string, unknown>).__backClicked = true;
      }}
    />,
  );
  return true;
}

function unmount(): void {
  if (root) {
    root.unmount();
    root = null;
  }
}

(window as unknown as Record<string, unknown>).__mountMarketplace = mount;
(window as unknown as Record<string, unknown>).__unmountMarketplace = unmount;
