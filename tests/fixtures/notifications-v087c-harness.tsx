/**
 * Harness entry for tests/notifications-v087c-renderer.test.mjs.
 *
 * Bundled with esbuild and mounted in a bare Electron window — no
 * main process, no preload. `__mountNotifications(scenario)` mounts
 * the real `NotificationsSection` with a mocked `window.openBot`, so
 * the test can check the per-kind toggles, the "Send test" button,
 * and the load-failure state without any real notification daemon.
 *
 * Scenarios:
 *   loaded           all three kinds ON; toggling approval OFF calls
 *                    setSettings with the merged object; "Send test"
 *                    shows the sent notice.
 *   test-unsupported "Send test" returns { shown: false, reason:
 *                    'unsupported' } -> the not-shown notice names
 *                    the reason instead of claiming a popup appeared.
 *   load-fails       getSettings rejects -> the load error, no crash.
 *
 * The section reads the real vi.json through useT (default locale is
 * vi), so assertions check the real Vietnamese strings. The
 * notification logic itself is covered by
 * tests/notifications-v087c.test.mjs, not here.
 */
import { createRoot, type Root } from 'react-dom/client';
import NotificationsSection from '../../apps/desktop/src/renderer/components/NotificationsSection';

let root: Root | null = null;

type KindSettings = { runComplete: boolean; approval: boolean; runError: boolean };

let current: KindSettings = { runComplete: true, approval: true, runError: true };

function installMock(scenario: string): void {
  const api: Record<string, unknown> = {
    getSettings: () =>
      scenario === 'load-fails'
        ? Promise.reject(new Error('settings failed'))
        : Promise.resolve({ notifications: { ...current } }),
    setSettings: (patch: { notifications?: Partial<KindSettings> }) => {
      if (patch?.notifications) {
        current = { ...current, ...patch.notifications };
      }
      return Promise.resolve({ notifications: { ...current } });
    },
    testNotification: () =>
      scenario === 'test-unsupported'
        ? Promise.resolve({ shown: false, reason: 'unsupported' })
        : Promise.resolve({ shown: true }),
  };
  (window as unknown as { openBot: unknown }).openBot = api;
}

function mountNotifications(scenario: string): boolean {
  current = { runComplete: true, approval: true, runError: true };
  installMock(scenario);
  const el = document.getElementById('root');
  if (!el) return false;
  if (root) {
    root.unmount();
    root = null;
  }
  root = createRoot(el);
  root.render(<NotificationsSection />);
  return true;
}

(window as unknown as { __mountNotifications: (s: string) => boolean }).__mountNotifications =
  mountNotifications;
