/**
 * Harness entry for tests/canvas-view-v086c-renderer.test.mjs.
 *
 * Bundled with esbuild and mounted in a bare Electron window — no
 * main process, no preload. `__mountCanvas(scenario)` mounts the
 * real `CanvasView` with a mocked `window.openBot`, so the test can
 * check the list, opening a canvas, the delete flow, and the empty
 * state without any bot or disk state.
 *
 * Scenarios:
 *   loaded     2 canvases (markdown+code, html); delete works.
 *   empty      the bot has no canvases.
 *   load-fails listCanvases rejects (load error, no crash).
 *
 * The mock data holds no secret and no real account. The view reads
 * the real vi.json through useT (default locale is vi), so
 * assertions check the real Vietnamese strings. The html canvas
 * contains a <script> on purpose: it must render inside the
 * sandboxed iframe and never execute (pageExceptions stays empty).
 */
import { createRoot, type Root } from 'react-dom/client';
import CanvasView from '../../apps/desktop/src/renderer/components/CanvasView';
import type { BotConfigLike } from '../../apps/desktop/src/renderer/types';

let root: Root | null = null;

const BOTS: BotConfigLike[] = [
  { id: 'bot-a', name: 'Bot A', providerId: 'ollama', model: 'llama3', systemPrompt: '', workspaceDir: '/tmp', autoApprove: false },
];

const DOCS: Record<string, unknown> = {
  c1: {
    id: 'c1',
    title: 'Ghi chú tuần',
    blocks: [
      { type: 'markdown', text: '# Kế hoạch\n\n- Làm X' },
      { type: 'code', language: 'js', code: 'console.log(1);' },
    ],
    version: 2,
    updatedAt: '2026-11-11T00:00:00.000Z',
    botId: 'bot-a',
  },
  c2: {
    id: 'c2',
    title: 'Trang HTML',
    blocks: [
      { type: 'html', html: '<h1>Xin chào</h1><script>window.parent.__canvasPwned = true</script>' },
    ],
    version: 1,
    updatedAt: '2026-11-10T00:00:00.000Z',
    botId: 'bot-a',
  },
};

function summaries() {
  return Object.values(DOCS).map((d) => {
    const doc = d as { id: string; title: string; version: number; updatedAt: string; blocks: unknown[] };
    return { id: doc.id, title: doc.title, version: doc.version, updatedAt: doc.updatedAt, blockCount: doc.blocks.length };
  });
}

function installMock(scenario: string): void {
  const api: Record<string, unknown> = {
    listCanvases: () =>
      scenario === 'load-fails'
        ? Promise.reject(new Error('list failed'))
        : Promise.resolve(scenario === 'empty' ? [] : summaries()),
    getCanvas: (_botId: string, id: string) => {
      const doc = DOCS[id];
      if (!doc) return Promise.reject(new Error('not found'));
      return Promise.resolve(JSON.parse(JSON.stringify(doc)));
    },
    deleteCanvas: (_botId: string, id: string) => {
      delete DOCS[id];
      return Promise.resolve({ deleted: true });
    },
    openCanvasInEditor: () => Promise.resolve({ opened: true }),
  };
  (window as unknown as { openBot: unknown }).openBot = api;
}

function mountCanvas(scenario: string): boolean {
  // Fresh docs per mount — the delete test mutates DOCS.
  DOCS.c1 = {
    id: 'c1',
    title: 'Ghi chú tuần',
    blocks: [
      { type: 'markdown', text: '# Kế hoạch\n\n- Làm X' },
      { type: 'code', language: 'js', code: 'console.log(1);' },
    ],
    version: 2,
    updatedAt: '2026-11-11T00:00:00.000Z',
    botId: 'bot-a',
  };
  DOCS.c2 = {
    id: 'c2',
    title: 'Trang HTML',
    blocks: [
      { type: 'html', html: '<h1>Xin chào</h1><script>window.parent.__canvasPwned = true</script>' },
    ],
    version: 1,
    updatedAt: '2026-11-10T00:00:00.000Z',
    botId: 'bot-a',
  };
  installMock(scenario);
  const el = document.getElementById('root');
  if (!el) return false;
  if (root) {
    root.unmount();
    root = null;
  }
  root = createRoot(el);
  root.render(<CanvasView bots={BOTS} botId="bot-a" onBack={() => undefined} />);
  return true;
}

(window as unknown as { __mountCanvas: (s: string) => boolean }).__mountCanvas = mountCanvas;
