/**
 * Harness entry for tests/plugin-marketplace-ui-v094a.test.mjs.
 *
 * Bundled with esbuild (see the test) and mounted in a bare Electron
 * window — no main process, no preload. The harness installs a mocked
 * `window.openBot` before mounting the real `McpMarketplaceView`, so
 * each scenario controls exactly what the plugin-tab IPC calls do:
 *
 *   - 'loaded' — two plugins (one downgradable, one not) + one
 *     trusted key. Downgrade swaps the two versions, like the real
 *     handler; add/remove mutate the mock key store.
 *   - 'downgrade-fails' — like 'loaded', but the downgrade IPC
 *     rejects: the error must surface and no success notice appear.
 *   - 'no-previous' — the plugin records a previous version, but
 *     downgrade-info says it cannot be restored (snapshot gone):
 *     no Downgrade button, and the reason is shown instead.
 *   - 'keys-error' — listing trusted keys rejects once, then
 *     answers on retry.
 *   - 'keys-empty' — no trusted keys: the empty state shows and the
 *     add form is the only way in.
 *
 * The mock data holds no secret and no real key: the PEM used in the
 * add flow is a fake marker-only string, and the listed keyIds are
 * fixed hex strings. The view reads the real vi.json through useT
 * (default locale is vi), so assertions check the real Vietnamese
 * strings.
 *
 * Comments are English only: the i18n test scans TSX files for
 * Vietnamese diacritics, comments included.
 */
import { createRoot, type Root } from 'react-dom/client';
import McpMarketplaceView from '../../apps/desktop/src/renderer/components/McpMarketplaceView';
import type {
  McpMarketplaceServerLike,
  McpServerConfigLike,
  PluginDowngradeInfoLike,
  PluginMarketplaceViewLike,
  TrustedMarketplaceKeyLike,
} from '../../apps/desktop/src/renderer/types';

export type HarnessScenario =
  | 'loaded'
  | 'downgrade-fails'
  | 'no-previous'
  | 'keys-error'
  | 'keys-empty';

/** Fake PEM: right markers, no real key material (the mock never verifies it). */
export const FAKE_PEM =
  '-----BEGIN PUBLIC KEY-----\nZmFrZS1rZXktbWF0ZXJpYWw=\n-----END PUBLIC KEY-----';

const ACME_KEY_ID =
  'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';

let root: Root | null = null;

function pluginRow(
  id: string,
  name: string,
  version: string,
  previousVersion: string | null,
): PluginMarketplaceViewLike {
  return {
    id,
    name,
    description: `${name} for the marketplace UI test.`,
    version,
    author: 'Test',
    enabled: true,
    tools: [`${id}_tool`],
    source: { kind: 'local', path: `/tmp/${id}` },
    sandboxed: true,
    installedAt: '2026-11-12T00:00:00.000Z',
    signatureStatus: 'signed',
    signatureKeyId: ACME_KEY_ID,
    previousVersion,
  };
}

function installMock(scenario: HarnessScenario): void {
  const win = window as unknown as Record<string, unknown>;
  win.__backClicked = false;
  // Mutable mock state, reset on every mount: the plugin list (so a
  // downgrade visibly swaps versions on reload) and the key store.
  let plugins: PluginMarketplaceViewLike[] = [
    pluginRow('demo-plugin', 'Demo Plugin', '2.0.0', '1.0.0'),
    pluginRow('plain-plugin', 'Plain Plugin', '1.0.0', null),
  ];
  if (scenario === 'no-previous') {
    plugins = [pluginRow('demo-plugin', 'Demo Plugin', '2.0.0', '0.9.0')];
  }
  let keys: TrustedMarketplaceKeyLike[] =
    scenario === 'keys-empty'
      ? []
      : [{ keyId: ACME_KEY_ID, label: 'Acme', addedAt: '2026-11-01T00:00:00.000Z' }];
  let keysListCalls = 0;
  const downgradeCalls: string[] = [];
  const addKeyCalls: Array<{ publicKey: string; label?: string }> = [];
  const removeKeyCalls: string[] = [];
  win.__downgradeCalls = downgradeCalls;
  win.__addKeyCalls = addKeyCalls;
  win.__removeKeyCalls = removeKeyCalls;
  const api: Record<string, unknown> = {
    // MCP tab (only the list calls matter — the view mounts on it).
    listMcpMarketplace: (): Promise<McpMarketplaceServerLike[]> => Promise.resolve([]),
    listMcpInstalled: (_botId: string): Promise<McpServerConfigLike[]> => Promise.resolve([]),
    listMcpServerTools: (id: string) =>
      Promise.resolve({ serverId: id, status: 'ok', tools: [], truncated: false }),
    checkMcpUpdates: (_botId: string) => Promise.resolve([]),
    installMcpServer: (id: string) => Promise.resolve({ name: id, config: { name: id }, nextSteps: [] }),
    uninstallMcpServer: (id: string) => Promise.resolve({ name: id }),
    approveMarketplace: () => Promise.resolve(undefined),
    // Plugin tab.
    listPluginMarketplace: (): Promise<PluginMarketplaceViewLike[]> =>
      Promise.resolve(plugins.map((p) => ({ ...p }))),
    searchPluginMarketplace: (query?: string): Promise<PluginMarketplaceViewLike[]> =>
      Promise.resolve(plugins.filter((p) => !query || p.name.includes(query))),
    preparePluginInstall: () => Promise.reject(new Error('not used by this harness')),
    installPluginMarketplace: () => Promise.reject(new Error('not used by this harness')),
    updatePluginMarketplace: () => Promise.reject(new Error('not used by this harness')),
    uninstallPluginMarketplace: () => Promise.reject(new Error('not used by this harness')),
    checkPluginUpdates: () => Promise.resolve([]),
    getPluginDowngradeInfo: (id: string): Promise<PluginDowngradeInfoLike> => {
      const plugin = plugins.find((p) => p.id === id);
      if (!plugin) {
        return Promise.resolve({
          id,
          currentVersion: '',
          previousVersion: null,
          canDowngrade: false,
          reason: `Plugin "${id}" is not installed via the marketplace.`,
        });
      }
      if (scenario === 'no-previous') {
        return Promise.resolve({
          id,
          currentVersion: plugin.version,
          previousVersion: plugin.previousVersion,
          canDowngrade: false,
          reason: `Plugin "${id}" recorded previous version ${plugin.previousVersion}, but its snapshot is missing from disk.`,
        });
      }
      return Promise.resolve({
        id,
        currentVersion: plugin.version,
        previousVersion: plugin.previousVersion,
        canDowngrade: plugin.previousVersion != null,
        ...(plugin.previousVersion == null
          ? { reason: `Plugin "${id}" has no previous version.` }
          : {}),
      });
    },
    downgradePluginMarketplace: (id: string) => {
      downgradeCalls.push(id);
      if (scenario === 'downgrade-fails') {
        return Promise.reject(new Error('snapshot is missing from disk'));
      }
      const plugin = plugins.find((p) => p.id === id);
      if (!plugin || plugin.previousVersion == null) {
        return Promise.reject(new Error(`Plugin "${id}" has no previous version.`));
      }
      // Swap roles, like the real handler: the current version becomes
      // the previous one, so a second downgrade goes back.
      const fromVersion = plugin.version;
      const toVersion = plugin.previousVersion;
      plugin.version = toVersion;
      plugin.previousVersion = fromVersion;
      return Promise.resolve({ id, fromVersion, toVersion });
    },
    listTrustedMarketplaceKeys: (): Promise<TrustedMarketplaceKeyLike[]> => {
      keysListCalls += 1;
      if (scenario === 'keys-error' && keysListCalls === 1) {
        return Promise.reject(new Error('keys store unreadable'));
      }
      return Promise.resolve(keys.map((k) => ({ ...k })));
    },
    addTrustedMarketplaceKey: (publicKey: string, label?: string) => {
      addKeyCalls.push({ publicKey, label });
      const keyId = `feedface${String(keys.length + 1).padStart(2, '0')}deadbeefcafe0000`;
      keys = [...keys, { keyId, ...(label ? { label } : {}), addedAt: '2026-11-12T00:00:00.000Z' }];
      return Promise.resolve({ keyId });
    },
    removeTrustedMarketplaceKey: (keyId: string) => {
      removeKeyCalls.push(keyId);
      const before = keys.length;
      keys = keys.filter((k) => k.keyId !== keyId);
      return Promise.resolve(keys.length < before);
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
(window as unknown as Record<string, unknown>).__fakePem = FAKE_PEM;
