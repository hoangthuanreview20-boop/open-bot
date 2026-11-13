/**
 * Harness entry for tests/sidebar-collapse-v079-renderer.test.mjs.
 *
 * Bundled with esbuild and mounted in a bare Electron window — no
 * main process, no preload. `__mountSidebar(collapsed)` mounts the
 * real `Sidebar` with two bots (one running, one with a pending
 * approval) in expanded or collapsed mode, so the test can check the
 * icon rail: names visible when expanded, hidden when collapsed, and
 * the avatar still selects the bot while collapsed.
 *
 * The mock data holds no secret and no real account. The sidebar reads
 * the real vi.json through useT (default locale is vi).
 */
import { createRoot, type Root } from 'react-dom/client';
import Sidebar from '../../apps/desktop/src/renderer/components/Sidebar';
import type { BotConfigLike } from '../../apps/desktop/src/renderer/types';

let root: Root | null = null;

const BOTS: BotConfigLike[] = [
  { id: 'bot-a', name: 'Bot A', providerId: 'ollama', model: 'llama3', systemPrompt: '', workspaceDir: '/tmp', autoApprove: false },
  { id: 'bot-b', name: 'Bot B', providerId: 'ollama', model: 'llama3', systemPrompt: '', workspaceDir: '/tmp', autoApprove: false },
];

const noop = () => undefined;

function mountSidebar(collapsed: boolean): boolean {
  const el = document.getElementById('root');
  if (!el) return false;
  if (root) {
    root.unmount();
    root = null;
  }
  (window as unknown as { __selectedBot: string | null }).__selectedBot = null;
  root = createRoot(el);
  root.render(
    <Sidebar
      bots={BOTS}
      selectedBotId="bot-a"
      onSelect={(id) => {
        (window as unknown as { __selectedBot: string | null }).__selectedBot = id;
      }}
      onCreate={noop}
      onEdit={noop}
      onDelete={noop}
      onClone={noop}
      botMeta={{ 'bot-b': { pinned: true, unread: true } }}
      onTogglePin={noop}
      onToggleHide={noop}
      onCopyConversationId={noop}
      onOpenDashboard={noop}
      onOpenPlanner={noop}
      onOpenSettings={noop}
      onOpenMarketplace={noop}
      onOpenMcpMarketplace={noop}
      onOpenMcpApps={noop}
      onOpenMcpTasks={noop}
      onOpenA2a={noop}
      onOpenTeam={noop}
      onOpenComputers={noop}
      onOpenFleet={noop}
      onOpenGroupChat={noop}
      onOpenSkills={noop}
      onOpenMemory={noop}
      onOpenCanvas={noop}
      onOpenAutomations={noop}
      onOpenTools={noop}
      onOpenInternetData={noop}
      onOpenEventLog={noop}
      onOpenConnectedApps={noop}
      threads={[]}
      selectedThreadId={null}
      threadSearchResults={null}
      onSelectThread={noop}
      onCreateThread={noop}
      onRenameThread={noop}
      onDeleteThread={noop}
      onSearchThreads={noop}
      runningBotIds={new Set(['bot-a'])}
      pendingCounts={{ 'bot-b': 2 }}
      collapsed={collapsed}
      onToggleCollapse={noop}
    />,
  );
  return true;
}

(window as unknown as { __mountSidebar: (c: boolean) => boolean }).__mountSidebar = mountSidebar;
