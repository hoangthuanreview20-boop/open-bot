/**
 * Harness entry for tests/group-status-v079-renderer.test.mjs.
 *
 * Bundled with esbuild and mounted in a bare Electron window — no
 * main process, no preload. `__mountGroupStatus(scenario)` mounts the
 * real `GroupView` with a mocked `window.openBot` whose
 * `getGroupBotStatus` reports a running bot in the `running` scenario
 * and no running bot in the `idle` scenario, so the test can check the
 * per-bot status chips + the "đang trả lời…" typing line (v0.79a).
 *
 * Scenarios:
 *   running      bot-a running (typing line + running chip for Bot A).
 *   idle         no bot running (no typing line, idle chips only).
 *   interrupted  (v0.82) bot-a was cut short when the app stopped:
 *                the warning line shows (NOT the typing line) and
 *                Dismiss removes it for good.
 *
 * The mock data holds no secret and no real account. The view reads
 * the real vi.json through useT (default locale is vi), so assertions
 * check the real Vietnamese strings.
 */
import { createRoot, type Root } from 'react-dom/client';
import GroupView from '../../apps/desktop/src/renderer/components/GroupView';
import type { BotConfigLike, GroupChatView } from '../../apps/desktop/src/renderer/types';

let root: Root | null = null;

const BOTS: BotConfigLike[] = [
  { id: 'bot-a', name: 'Bot A', providerId: 'ollama', model: 'llama3', systemPrompt: '', workspaceDir: '/tmp', autoApprove: false },
  { id: 'bot-b', name: 'Bot B', providerId: 'ollama', model: 'llama3', systemPrompt: '', workspaceDir: '/tmp', autoApprove: false },
];

const GROUPS: GroupChatView[] = [
  { id: 'g1', name: 'Nhóm 1', botIds: ['bot-a', 'bot-b'], createdAt: '2026-11-10T00:00:00.000Z' },
];

function installMock(scenario: string): void {
  const running =
    scenario === 'running'
      ? [{ botId: 'bot-a', status: 'running' as const, since: '2026-11-11T00:00:00.000Z' }]
      : [];
  // v0.82: mutable so the dismiss mock really clears it (the view
  // polls every 2s — a stale mock would resurrect the warning line).
  let interrupted: Array<{ botId: string; since: string }> =
    scenario === 'interrupted'
      ? [{ botId: 'bot-a', since: '2026-11-11T00:00:00.000Z' }]
      : [];
  const dismissCalls: Array<{ groupId: string; botId: string }> = [];
  (window as unknown as { __dismissCalls: Array<{ groupId: string; botId: string }> }).__dismissCalls =
    dismissCalls;
  const api: Record<string, unknown> = {
    listGroupChats: () => Promise.resolve(GROUPS.map((g) => ({ ...g }))),
    listGroupMessages: () => Promise.resolve([]),
    createGroupChat: ({ name }: { name: string }) =>
      Promise.resolve({ group: { id: 'g2', name, botIds: [], createdAt: '2026-11-10T00:00:00.000Z' } }),
    addBotToGroupChat: () => Promise.resolve({ added: true }),
    deleteGroupChat: () => Promise.resolve({}),
    postGroupMessage: () => Promise.resolve({}),
    getGroupBotStatus: () => Promise.resolve({ groupId: 'g1', running, interrupted }),
    dismissGroupBotInterrupted: ({ groupId, botId }: { groupId: string; botId: string }) => {
      dismissCalls.push({ groupId, botId });
      interrupted = interrupted.filter((e) => e.botId !== botId);
      return Promise.resolve({ groupId, botId, dismissed: true });
    },
  };
  (window as unknown as { openBot: unknown }).openBot = api;
}

function mountGroupStatus(scenario: string): boolean {
  installMock(scenario);
  const el = document.getElementById('root');
  if (!el) return false;
  if (root) {
    root.unmount();
    root = null;
  }
  root = createRoot(el);
  root.render(<GroupView bots={BOTS} onBack={() => undefined} />);
  return true;
}

(window as unknown as { __mountGroupStatus: (s: string) => boolean }).__mountGroupStatus = mountGroupStatus;
