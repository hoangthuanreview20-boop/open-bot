/**
 * Harness entry for tests/bot-description-v077-renderer.test.mjs.
 *
 * Bundled with esbuild and mounted in a bare Electron window — no
 * main process, no preload. Exposes:
 *   `__mountSidebar()` — the real `Sidebar` with two bots: bot A has
 *     a short description, bot B has none.
 *   `__mountBotForm(mode)` — the real `BotForm`; modes:
 *     'create'   initial null (new bot); `listTemplates` returns one
 *                template whose description prefills the field when
 *                the template is picked.
 *     'edit'     initial = bot A (has a description) — the field is
 *                prefilled with it.
 *   `onSave` captures the submitted config into `window.__savedBot`
 *   (read back by the test through CDP) and resolves.
 *
 * The mock data holds no secret. The views read the real vi.json
 * through useT (default locale is vi), so assertions check the real
 * Vietnamese strings.
 */
import { createRoot, type Root } from 'react-dom/client';
import Sidebar from '../../apps/desktop/src/renderer/components/Sidebar';
import BotForm from '../../apps/desktop/src/renderer/components/BotForm';
import type { AgentTemplateLike, BotConfigLike } from '../../apps/desktop/src/renderer/types';

let root: Root | null = null;

const BOTS: BotConfigLike[] = [
  {
    id: 'bot-a',
    name: 'Bot A',
    providerId: 'ollama',
    model: 'llama3',
    systemPrompt: '',
    workspaceDir: '/tmp',
    autoApprove: false,
    description: 'Trợ lý viết code, am hiểu TypeScript',
  },
  {
    id: 'bot-b',
    name: 'Bot B',
    providerId: 'xai',
    model: 'grok-4',
    systemPrompt: '',
    workspaceDir: '/tmp',
    autoApprove: false,
  },
];

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

function installMock(): void {
  const api: Record<string, unknown> = {
    listTemplates: () => Promise.resolve([TEMPLATE]),
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

function mountSidebar(): boolean {
  installMock();
  const noop = () => undefined;
  return mount(
    document.getElementById('root'),
    <Sidebar
      bots={BOTS}
      selectedBotId="bot-a"
      onSelect={noop}
      onCreate={noop}
      onEdit={noop}
      onDelete={noop}
      onClone={noop}
      onOpenSettings={noop}
      onOpenMarketplace={noop}
      onOpenMcpMarketplace={noop}
      onOpenA2a={noop}
      onOpenTeam={noop}
      onOpenComputers={noop}
      onOpenGroupChat={noop}
      onOpenSkills={noop}
      onOpenAutomations={noop}
      onOpenTools={noop}
      onOpenConnectedApps={noop}
      threads={[]}
      selectedThreadId={null}
      threadSearchResults={null}
      onSelectThread={noop}
      onCreateThread={noop}
      onRenameThread={noop}
      onDeleteThread={noop}
      onSearchThreads={noop}
      runningBotIds={new Set()}
      pendingCounts={{}}
    />,
  );
}

function mountBotForm(mode: string): boolean {
  installMock();
  (window as unknown as { __savedBot: unknown }).__savedBot = null;
  const onSave = (config: Partial<BotConfigLike> & { id?: string }) => {
    (window as unknown as { __savedBot: unknown }).__savedBot = config;
    return Promise.resolve();
  };
  return mount(
    document.getElementById('root'),
    <BotForm
      initial={mode === 'edit' ? BOTS[0] : null}
      onSave={onSave}
      onCancel={() => undefined}
    />,
  );
}

(window as unknown as { __mountSidebar: () => boolean }).__mountSidebar = mountSidebar;
(window as unknown as { __mountBotForm: (m: string) => boolean }).__mountBotForm = mountBotForm;
