/**
 * Harness entry for tests/template-plugin-modal-v070.test.mjs.
 *
 * Bundled with esbuild and mounted in a bare Electron window — no main
 * process, no preload. `__mountTemplateModal(scenario)` mounts the
 * REAL `TemplatePluginModal` with a mocked `window.openBot` whose
 * `listPluginTemplates` is controlled by the scenario:
 *
 *   loading: the list call never settles (loading line must stay
 *            visible, no empty line, no retry button).
 *   error:   the first call rejects, later calls answer with one
 *            sample template (error + retry must show; clicking
 *            retry must load the template and clear the error).
 *   loaded:  the call answers with one sample template.
 *   empty:   the call answers with no templates (empty line, no
 *            loading line, no retry button).
 *
 * The mock data holds no secret and no real account. The modal reads
 * the real vi.json through `useT`, so assertions can check the real
 * Vietnamese strings.
 *
 * Comments are English only: the i18n test scans TSX files for
 * Vietnamese diacritics, comments included.
 */
import { createRoot, type Root } from 'react-dom/client';
import TemplatePluginModal from '../../apps/desktop/src/renderer/components/TemplatePluginModal';

const SAMPLE_TEMPLATE = {
  id: 'quick-notes',
  name: 'Quick Notes',
  description: 'A sample template.',
  manifest: {
    id: 'quick-notes',
    name: 'Quick Notes',
    version: '1.0.0',
    description: 'A sample template.',
    author: 'Test',
    permissions: ['fs'],
    main: 'index.js',
    tools: ['notes_create'],
  },
  config: {},
  createdAt: '2026-11-10T00:00:00.000Z',
};

let root: Root | null = null;
let loadCalls = 0;
let currentScenario = 'loaded';

const neverSettles = (): Promise<never> => new Promise(() => {
  // Intentionally never resolves: the loading state must stay visible.
});

function listPluginTemplates(): Promise<unknown> {
  loadCalls += 1;
  if (currentScenario === 'loading') return neverSettles();
  if (currentScenario === 'error' && loadCalls === 1) {
    return Promise.reject(new Error('ipc-boom'));
  }
  if (currentScenario === 'empty') return Promise.resolve([]);
  return Promise.resolve([SAMPLE_TEMPLATE]);
}

function mountTemplateModal(scenario: string): boolean {
  currentScenario = scenario;
  loadCalls = 0;
  const el = document.getElementById('root');
  if (!el) return false;
  (window as unknown as Record<string, unknown>).openBot = {
    listPluginTemplates,
    createPluginTemplate: async () => SAMPLE_TEMPLATE,
    applyPluginTemplate: async () => ({ manifest: SAMPLE_TEMPLATE.manifest, hasEntry: false }),
    exportPluginTemplate: async () => ({ json: '{}' }),
    importPluginTemplate: async () => SAMPLE_TEMPLATE,
    deletePluginTemplate: async () => undefined,
  };
  if (root) {
    root.unmount();
    root = null;
  }
  root = createRoot(el);
  root.render(
    <TemplatePluginModal onClose={() => {}} onInstalled={() => {}} />,
  );
  return true;
}

(window as unknown as Record<string, unknown>).__mountTemplateModal = mountTemplateModal;
(window as unknown as Record<string, unknown>).__templateLoadCalls = () => loadCalls;
