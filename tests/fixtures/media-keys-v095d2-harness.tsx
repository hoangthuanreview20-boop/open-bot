/**
 * Harness entry for tests/media-keys-v095d2-renderer.test.mjs.
 *
 * Bundled with esbuild and mounted in a bare Electron window — no
 * main process, no preload. `__mountMediaKeys(scenario)` mounts the
 * real `MediaKeysSection` with a mocked `window.openBot`, so the test
 * can check the provider list, save/clear flows and the load error
 * without any real key or Vault state.
 *
 * Scenarios:
 *   loaded     openai configured (suffix 4444), the other 6 missing;
 *              save stores a typed fake key (suffix shown, input
 *              cleared), clear removes the openai key.
 *   load-fails getMediaKeyStatus rejects -> the load error, no crash.
 *
 * The mock data holds fake keys only. The section reads the real
 * vi.json through useT (default locale is vi), so assertions check
 * the real Vietnamese strings. The full fake key never appears in
 * the rendered page — only its last 4 characters.
 */
import { createRoot, type Root } from 'react-dom/client';
import MediaKeysSection from '../../apps/desktop/src/renderer/components/MediaKeysSection';
import type { MediaKeyStatusView } from '../../apps/desktop/src/renderer/types';

let root: Root | null = null;

type Status = MediaKeyStatusView;

function freshStatus(): Status {
  return {
    openai: { configured: true, suffix: '4444' },
    gemini: { configured: false, suffix: null },
    stability: { configured: false, suffix: null },
    replicate: { configured: false, suffix: null },
    runway: { configured: false, suffix: null },
    luma: { configured: false, suffix: null },
    pika: { configured: false, suffix: null },
  };
}

let STATUS: Status = freshStatus();

function installMock(scenario: string): void {
  const api: Record<string, unknown> = {
    getMediaKeyStatus: () =>
      scenario === 'load-fails'
        ? Promise.reject(new Error('status boom'))
        : Promise.resolve(JSON.parse(JSON.stringify(STATUS))),
    setMediaKey: (providerId: string, apiKey: string) => {
      if (typeof apiKey !== 'string' || !apiKey.trim()) {
        return Promise.reject(new Error('Media API key must not be empty.'));
      }
      const known = ['openai', 'gemini', 'stability', 'replicate', 'runway', 'luma', 'pika'];
      if (!known.includes(providerId)) {
        return Promise.reject(new Error(`Unknown media provider "${providerId}".`));
      }
      STATUS[providerId] = { configured: true, suffix: apiKey.trim().slice(-4) };
      return Promise.resolve(JSON.parse(JSON.stringify(STATUS)));
    },
    clearMediaKey: (providerId: string) => {
      STATUS[providerId] = { configured: false, suffix: null };
      return Promise.resolve(JSON.parse(JSON.stringify(STATUS)));
    },
  };
  (window as unknown as { openBot: unknown }).openBot = api;
}

function mountMediaKeys(scenario: string): boolean {
  STATUS = freshStatus();
  installMock(scenario);
  const el = document.getElementById('root');
  if (!el) return false;
  if (root) {
    root.unmount();
    root = null;
  }
  root = createRoot(el);
  root.render(<MediaKeysSection />);
  return true;
}

(window as unknown as { __mountMediaKeys: (s: string) => boolean }).__mountMediaKeys =
  mountMediaKeys;
