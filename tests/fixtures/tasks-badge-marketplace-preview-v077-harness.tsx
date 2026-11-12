/**
 * Harness entry for tests/tasks-badge-marketplace-preview-v077-renderer.test.mjs.
 *
 * Bundled with esbuild and mounted in a bare Electron window — no
 * main process, no preload. Exposes:
 *   `__mountTasksToggle(runningCount)` — the real
 *     `TasksToggleButton` with that many running tasks.
 *   `__mountMarketplace()` — the real `AgentMarketplaceView` with a
 *     mocked `window.openBot`: one template + one published entry.
 *     Install/use captures the created bot into `window.__installedBot`.
 *
 * The mock data holds no secret. The views read the real vi.json
 * through useT (default locale is vi), so assertions check the real
 * Vietnamese strings.
 */
import { createRoot, type Root } from 'react-dom/client';
import TasksToggleButton from '../../apps/desktop/src/renderer/components/TasksToggleButton';
import AgentMarketplaceView from '../../apps/desktop/src/renderer/components/AgentMarketplaceView';
import type { AgentTemplateLike, BotConfigLike, PublishedAgentLike } from '../../apps/desktop/src/renderer/types';

let root: Root | null = null;

const TEMPLATE: AgentTemplateLike = {
  id: 'tpl-code',
  name: 'Mẫu code',
  description: 'Mẫu bot viết code',
  category: 'coding',
  systemPrompt: 'Bạn là trợ lý viết code.',
  providerId: 'ollama',
  model: 'llama3',
  suggestedTools: ['read_file'],
};

const PUBLISHED: PublishedAgentLike = {
  id: 'pub-1',
  name: 'Bot đã chia sẻ',
  description: 'Bot chia sẻ mẫu',
  config: {
    id: 'bot-pub',
    name: 'Bot đã chia sẻ',
    providerId: 'xai',
    model: 'grok-4',
    systemPrompt: 'Bạn là bot chia sẻ.',
    workspaceDir: '',
    autoApprove: false,
  },
  author: 'alice',
  createdAt: '2026-11-11T00:00:00.000Z',
  installs: 3,
};

function installMock(): void {
  const api: Record<string, unknown> = {
    listTemplates: () => Promise.resolve([TEMPLATE]),
    listMarketplace: () => Promise.resolve([PUBLISHED]),
    createBot: (config: Partial<BotConfigLike>) => {
      const bot: BotConfigLike = {
        id: 'bot-new',
        name: config.name ?? 'Bot mới',
        providerId: config.providerId ?? 'xai',
        model: config.model ?? '',
        systemPrompt: config.systemPrompt ?? '',
        workspaceDir: '',
        autoApprove: false,
      };
      (window as unknown as { __installedBot: unknown }).__installedBot = bot;
      return Promise.resolve(bot);
    },
    installMarketplace: () => {
      const bot: BotConfigLike = { ...PUBLISHED.config, id: 'bot-installed' };
      (window as unknown as { __installedBot: unknown }).__installedBot = bot;
      return Promise.resolve(bot);
    },
    uninstallMarketplace: () => Promise.resolve(),
    publishAgent: () => Promise.resolve(PUBLISHED),
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

function mountTasksToggle(runningCount: number): boolean {
  return mount(
    document.getElementById('root'),
    <TasksToggleButton showTasks={false} runningCount={runningCount} onToggle={() => undefined} />,
  );
}

function mountMarketplace(): boolean {
  installMock();
  (window as unknown as { __installedBot: unknown }).__installedBot = null;
  return mount(
    document.getElementById('root'),
    <AgentMarketplaceView bots={[]} onBack={() => undefined} onBotInstalled={() => undefined} />,
  );
}

(window as unknown as { __mountTasksToggle: (n: number) => boolean }).__mountTasksToggle =
  mountTasksToggle;
(window as unknown as { __mountMarketplace: () => boolean }).__mountMarketplace = mountMarketplace;
