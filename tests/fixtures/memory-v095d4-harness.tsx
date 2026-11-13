/**
 * Harness entry for tests/memory-ui-v095d4.test.mjs.
 *
 * Bundled with esbuild and mounted in a bare Electron window — no
 * main process, no preload. `__mountMemory()` mounts the real
 * `MemoryView` and `__mountProfile()` the real `ProfileSection`, both
 * with a mocked `window.openBot` that keeps memories/profile in
 * memory and records every call in `window.__memoryCalls`, so the
 * test can assert the UI drove the right calls without any real
 * Vault, Ollama or filesystem.
 *
 * The mock data holds no secret and no real account. The views read
 * the real vi.json through useT (default locale is vi), so
 * assertions check the real Vietnamese strings.
 */
import { createRoot, type Root } from 'react-dom/client';
import MemoryView from '../../apps/desktop/src/renderer/components/MemoryView';
import ProfileSection from '../../apps/desktop/src/renderer/components/ProfileSection';
import type { BotConfigLike, MemoryEntryView, UserProfileView } from '../../apps/desktop/src/renderer/types';

let root: Root | null = null;

const BOTS: BotConfigLike[] = [
  { id: 'bot-a', name: 'Bot A', providerId: 'ollama', model: 'llama3', systemPrompt: '', workspaceDir: '/tmp', autoApprove: false },
  { id: 'bot-b', name: 'Bot B', providerId: 'ollama', model: 'llama3', systemPrompt: '', workspaceDir: '/tmp', autoApprove: false },
];

const MEM1: MemoryEntryView = {
  id: 'mem-1', key: 'sở thích ăn uống', value: 'thích phở bò', tags: ['ăn uống'],
  confidence: 0.9, botId: '', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
};
const MEM2: MemoryEntryView = {
  id: 'mem-2', key: 'dự án', value: 'đang làm open-bot', tags: [],
  confidence: 0.8, botId: 'bot-a', createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z',
};

let memories: MemoryEntryView[] = [];
let profile: UserProfileView = {
  userId: 'user-1', displayName: 'Huy', addressForm: 'bạn',
  interests: ['phở bò'], habits: ['chạy bộ sáng'], facts: [], createdAt: 1000,
};

const calls = {
  profileUpdates: [] as Array<Record<string, unknown>>,
  memoryUpdates: [] as Array<Record<string, unknown>>,
  memoryDeletes: [] as string[],
  exports: [] as string[],
  blobUrls: [] as string[],
};

function installMock(): void {
  memories = [{ ...MEM1 }, { ...MEM2 }];
  profile = {
    userId: 'user-1', displayName: 'Huy', addressForm: 'bạn',
    interests: ['phở bò'], habits: ['chạy bộ sáng'], facts: [], createdAt: 1000,
  };
  calls.profileUpdates = [];
  calls.memoryUpdates = [];
  calls.memoryDeletes = [];
  calls.exports = [];
  calls.blobUrls = [];
  // Export downloads a Blob — in the harness, capture the URL instead
  // of letting Electron open a download dialog.
  const urlApi = window.URL as unknown as { createObjectURL: (b: Blob) => string; revokeObjectURL: (u: string) => void };
  urlApi.createObjectURL = (blob: Blob) => {
    calls.blobUrls.push('blob:mock');
    void blob;
    return 'blob:mock';
  };
  urlApi.revokeObjectURL = () => undefined;
  const anchorProto = window.HTMLAnchorElement.prototype as unknown as { click: () => void };
  anchorProto.click = () => undefined;
  const api: Record<string, unknown> = {
    listBots: () => Promise.resolve(BOTS.map((b) => ({ ...b }))),
    getUserProfile: () => Promise.resolve({ ...profile }),
    updateUserProfile: (patch: Record<string, unknown>) => {
      calls.profileUpdates.push({ ...patch });
      profile = { ...profile, ...patch };
      return Promise.resolve({ ...profile });
    },
    listMemories: (payload: { botId: string; query?: string }) => {
      const q = (payload.query ?? '').toLowerCase();
      const rows = memories.filter(
        (m) => (m.botId === '' || m.botId === payload.botId) &&
          (q === '' || `${m.key} ${m.value} ${m.tags.join(' ')}`.toLowerCase().includes(q)),
      );
      return Promise.resolve(rows.map((m) => ({ ...m })));
    },
    updateMemory: (payload: { botId: string; id: string; value?: string; tags?: string[] }) => {
      calls.memoryUpdates.push({ ...payload });
      const target = memories.find((m) => m.id === payload.id);
      if (!target) return Promise.reject(new Error('Không tìm thấy memory.'));
      if (payload.value !== undefined) target.value = payload.value;
      if (payload.tags !== undefined) target.tags = payload.tags;
      target.updatedAt = new Date().toISOString();
      return Promise.resolve({ ...target });
    },
    deleteMemory: (payload: { botId: string; id: string }) => {
      calls.memoryDeletes.push(payload.id);
      memories = memories.filter((m) => m.id !== payload.id);
      return Promise.resolve({ deleted: true });
    },
    exportMemories: (payload: { botId: string }) => {
      calls.exports.push(payload.botId);
      return Promise.resolve(JSON.stringify({ version: 1, entries: memories }, null, 2));
    },
    getMemoryStatus: () => Promise.resolve({
      total: memories.length, embedded: 1, ollamaAvailable: true, embeddingModel: 'nomic-embed-text',
    }),
  };
  (window as unknown as { openBot: unknown }).openBot = api;
  (window as unknown as { __memoryCalls: unknown }).__memoryCalls = calls;
}

function mountMemory(): boolean {
  installMock();
  const el = document.getElementById('root');
  if (!el) return false;
  if (root) {
    root.unmount();
    root = null;
  }
  root = createRoot(el);
  root.render(<MemoryView bots={BOTS} botId="bot-a" onBack={() => undefined} onSelectBot={() => undefined} />);
  return true;
}

function mountProfile(): boolean {
  installMock();
  const el = document.getElementById('root');
  if (!el) return false;
  if (root) {
    root.unmount();
    root = null;
  }
  root = createRoot(el);
  root.render(<ProfileSection />);
  return true;
}

(window as unknown as { __mountMemory: () => boolean }).__mountMemory = mountMemory;
(window as unknown as { __mountProfile: () => boolean }).__mountProfile = mountProfile;
