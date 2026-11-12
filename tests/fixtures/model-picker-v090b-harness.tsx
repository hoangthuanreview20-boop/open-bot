/**
 * Harness entry for tests/model-picker-v090b-renderer.test.mjs.
 *
 * Bundled with esbuild and mounted in a bare Electron window — no
 * main process, no preload. Exposes:
 *   `__mountModelPicker(mode)` — the real `ModelPicker`; modes:
 *     'current-disabled'      value xai/grok-4.7, disabledProviders ['xai']
 *     'current-disabled-plus' value xai/grok-4.7, disabledProviders ['xai', 'openai']
 *     'all-enabled'           value xai/grok-4.7, disabledProviders []
 *   `onSelect` captures the picked model into `window.__picked`.
 *   `__mountBotForm()` — the real `BotForm` in edit mode for a bot
 *     whose provider (xai) is disabled for the bot; `onSave` captures
 *     the submitted config into `window.__savedBot`.
 *
 * The mock `window.openBot` implements the same per-bot rail filter
 * the main process applies (see `filterRailForBot` in core): disabled
 * non-current entries are hidden, the disabled current entry stays
 * dimmed with reason 'bot-disabled'. Call counts are exposed as
 * `window.__railCalls` / `window.__redetectCalls` so the test can
 * prove the Re-detect button really rescans and reloads the rail.
 *
 * The mock data holds no secret. The views read the real vi.json
 * through useT (default locale is vi), so assertions check the real
 * Vietnamese strings.
 */
import { createRoot, type Root } from 'react-dom/client';
import ModelPicker from '../../apps/desktop/src/renderer/components/ModelPicker';
import BotForm from '../../apps/desktop/src/renderer/components/BotForm';
import type { BotConfigLike, ProviderRailView } from '../../apps/desktop/src/renderer/types';

let root: Root | null = null;

const FULL_RAIL: ProviderRailView = {
  groups: {
    subscription: [
      {
        providerId: 'claude-code',
        label: 'Claude Code (CLI)',
        group: 'subscription',
        status: 'usable',
        selectable: true,
        sourceKind: 'account',
        accountLabel: 'alice@example.com',
        models: ['claude-code'],
        defaultModel: 'claude-code',
      },
    ],
    api: [
      {
        providerId: 'xai',
        label: 'xAI',
        group: 'api',
        status: 'usable',
        selectable: true,
        sourceKind: 'api-key',
        models: ['grok-4.7'],
        defaultModel: 'grok-4.7',
      },
      {
        providerId: 'openai',
        label: 'OpenAI',
        group: 'api',
        status: 'usable',
        selectable: true,
        sourceKind: 'api-key',
        models: ['gpt-5'],
        defaultModel: 'gpt-5',
      },
      {
        providerId: 'ollama',
        label: 'Ollama',
        group: 'api',
        status: 'usable',
        selectable: true,
        sourceKind: 'local',
        models: ['qwen2.5:0.5b'],
        defaultModel: 'qwen2.5:0.5b',
      },
    ],
    custom: [],
  },
  entries: [],
};
FULL_RAIL.entries = [
  ...FULL_RAIL.groups.subscription,
  ...FULL_RAIL.groups.api,
  ...FULL_RAIL.groups.custom,
];

type Win = typeof window & {
  __picked?: { providerId: string; model: string } | null;
  __savedBot?: (Partial<BotConfigLike> & { id?: string }) | null;
  __railCalls?: number;
  __redetectCalls?: number;
  __lastRailPayload?: unknown;
};

function filterRail(
  payload?: { disabledProviders?: string[]; currentProviderId?: string },
): ProviderRailView {
  const disabled = new Set(payload?.disabledProviders ?? []);
  const w = window as Win;
  w.__railCalls = (w.__railCalls ?? 0) + 1;
  w.__lastRailPayload = payload ?? null;
  const clone: ProviderRailView = JSON.parse(JSON.stringify(FULL_RAIL));
  if (disabled.size === 0) return clone;
  const entries = clone.entries
    .filter((e) => !disabled.has(e.providerId) || e.providerId === payload?.currentProviderId)
    .map((e) =>
      disabled.has(e.providerId) && e.providerId === payload?.currentProviderId
        ? { ...e, status: 'unavailable' as const, selectable: false, reason: 'bot-disabled' }
        : e,
    );
  return {
    groups: {
      subscription: entries.filter((e) => e.group === 'subscription'),
      api: entries.filter((e) => e.group === 'api'),
      custom: entries.filter((e) => e.group === 'custom'),
    },
    entries,
  };
}

function installMock(): void {
  const api: Record<string, unknown> = {
    listModelRail: (payload?: { disabledProviders?: string[]; currentProviderId?: string }) =>
      Promise.resolve(filterRail(payload)),
    redetectEngines: () => {
      const w = window as Win;
      w.__redetectCalls = (w.__redetectCalls ?? 0) + 1;
      return Promise.resolve({ engines: {} });
    },
    setEngineEnabled: () => Promise.resolve({ engines: {} }),
    listTemplates: () => Promise.resolve([]),
    onEnginesChanged: () => () => undefined,
  };
  (window as unknown as { openBot: unknown }).openBot = api;
}

function mount(el: HTMLElement | null, node: React.ReactNode): boolean {
  if (!el) return false;
  if (root) {
    root.unmount();
    root = null;
  }
  root = createRoot(el);
  root.render(node);
  return true;
}

const BOT_A: BotConfigLike = {
  id: 'bot-a',
  name: 'Bot A',
  providerId: 'xai',
  model: 'grok-4.7',
  systemPrompt: '',
  workspaceDir: '/tmp',
  autoApprove: false,
  disabledProviders: ['xai'],
};

function mountModelPicker(mode: string): boolean {
  installMock();
  const w = window as Win;
  w.__picked = null;
  w.__railCalls = 0;
  w.__redetectCalls = 0;
  const disabledProviders =
    mode === 'current-disabled-plus' ? ['xai', 'openai'] : mode === 'current-disabled' ? ['xai'] : [];
  return mount(
    document.getElementById('root'),
    <ModelPicker
      value={{ providerId: 'xai', model: 'grok-4.7' }}
      onSelect={(sel) => {
        w.__picked = sel;
      }}
      onToggleEngine={() => Promise.resolve()}
      disabledProviders={disabledProviders}
    />,
  );
}

function mountBotForm(): boolean {
  installMock();
  const w = window as Win;
  w.__savedBot = null;
  w.__railCalls = 0;
  w.__redetectCalls = 0;
  const onSave = (config: Partial<BotConfigLike> & { id?: string }) => {
    w.__savedBot = config;
    return Promise.resolve();
  };
  return mount(
    document.getElementById('root'),
    <BotForm initial={BOT_A} onSave={onSave} onCancel={() => undefined} />,
  );
}

(window as unknown as { __mountModelPicker: (m: string) => boolean }).__mountModelPicker =
  mountModelPicker;
(window as unknown as { __mountBotForm: () => boolean }).__mountBotForm = mountBotForm;
