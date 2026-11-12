/**
 * Harness entry for tests/group-view-v073-renderer.test.mjs.
 *
 * Bundled with esbuild and mounted in a bare Electron window — no
 * main process, no preload. `__mountGroup(scenario)` mounts the
 * real `GroupView` with a mocked `window.openBot` whose add/delete
 * calls reject in the failure scenarios, so the test can check
 * which error message the view shows for each failed action.
 *
 * Scenarios:
 *   loaded       list ok, add + delete ok.
 *   add-fails    addBotToGroupChat rejects.
 *   delete-fails deleteGroupChat rejects.
 *   with-attachments (v0.94c): one message carries an image
 *     attachment; getGroupAttachment returns its bytes and
 *     postGroupMessage records its payload on
 *     `window.__lastGroupPost` so the test can assert the bytes sent.
 *
 * The mock data holds no secret and no real account. The view reads
 * the real vi.json through useT (default locale is vi), so
 * assertions check the real Vietnamese strings.
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
  { id: 'g1', name: 'Nhóm 1', botIds: ['bot-a'], createdAt: '2026-11-10T00:00:00.000Z' },
];

// v0.94c: PNG 1x1 trong suốt (base64) — ảnh đính kèm mẫu cho scenario
// with-attachments (đủ để hiện thumbnail + gửi đi).
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=';

const ATTACH_MESSAGE = {
  id: 'm1',
  groupId: 'g1',
  botId: '',
  botName: 'Bạn',
  text: 'xem ảnh này',
  mentions: [],
  delegated: false,
  attachments: [{ id: 'att-1', mimeType: 'image/png', name: 'anh.png', sizeBytes: 70, file: 'x.png' }],
  createdAt: '2026-11-10T00:00:00.000Z',
};

function installMock(scenario: string): void {
  const api: Record<string, unknown> = {
    listGroupChats: () => Promise.resolve(GROUPS.map((g) => ({ ...g }))),
    listGroupMessages: () =>
      Promise.resolve(
        scenario === 'with-attachments'
          ? [{ ...ATTACH_MESSAGE, attachments: ATTACH_MESSAGE.attachments.map((a) => ({ ...a })) }]
          : [],
      ),
    createGroupChat: ({ name }: { name: string }) =>
      Promise.resolve({ group: { id: 'g2', name, botIds: [], createdAt: '2026-11-10T00:00:00.000Z' } }),
    addBotToGroupChat: () =>
      scenario === 'add-fails'
        ? Promise.reject(new Error('add failed'))
        : Promise.resolve({ added: true }),
    deleteGroupChat: () =>
      scenario === 'delete-fails'
        ? Promise.reject(new Error('delete failed'))
        : Promise.resolve({}),
    // v0.94c: ghi lại payload gửi nhóm để test assert bytes ảnh.
    postGroupMessage: (payload: unknown) => {
      (window as unknown as { __lastGroupPost: unknown }).__lastGroupPost = payload;
      return Promise.resolve({ message: { ...ATTACH_MESSAGE, id: 'm-sent' }, replies: [] });
    },
    // v0.94c: trả bytes ảnh mẫu cho thumbnail.
    getGroupAttachment: () => {
      const w = window as unknown as { __attachCalls?: number };
      w.__attachCalls = (w.__attachCalls ?? 0) + 1;
      return Promise.resolve({ attachment: { mimeType: 'image/png', data: PNG_1X1, name: 'anh.png' } });
    },
  };
  (window as unknown as { openBot: unknown }).openBot = api;
}

function mountGroup(scenario: string): boolean {
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

(window as unknown as { __mountGroup: (s: string) => boolean }).__mountGroup = mountGroup;
