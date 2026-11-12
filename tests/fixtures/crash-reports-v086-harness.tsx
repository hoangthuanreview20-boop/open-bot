/**
 * Harness entry for tests/crash-reports-v086-renderer.test.mjs.
 *
 * Bundled with esbuild and mounted in a bare Electron window — no
 * main process, no preload. `__mountCrashReports(scenario)` mounts
 * the real `CrashReportsSection` with a mocked `window.openBot`, so
 * the test can check the opt-in toggle, the list, opening a report,
 * delete one / delete all, and the empty state without any real
 * crash or disk state.
 *
 * Scenarios:
 *   loaded     toggle OFF, 2 reports; toggle works, open shows the
 *              detail, delete removes one, delete-all removes the rest.
 *   empty      toggle OFF, no reports -> the empty message, no crash.
 *   load-fails listCrashReports rejects -> the load error, no crash.
 *
 * The mock data holds no secret and no real account. The section
 * reads the real vi.json through useT (default locale is vi), so
 * assertions check the real Vietnamese strings. Report messages in
 * the mock are already redacted (`<home>`) — redaction itself is
 * covered by tests/crash-reporting-v086.test.mjs, not here.
 */
import { createRoot, type Root } from 'react-dom/client';
import CrashReportsSection from '../../apps/desktop/src/renderer/components/CrashReportsSection';

let root: Root | null = null;
let enabled = false;

interface MockReport {
  id: string;
  createdAt: string;
  source: 'main' | 'renderer';
  kind: 'uncaughtException' | 'unhandledRejection' | 'renderer-error';
  message: string;
  stack?: string;
  platform: string;
  appVersion?: string;
  sent: boolean;
}

let REPORTS: Record<string, MockReport> = {};

function freshReports(): Record<string, MockReport> {
  return {
    r1: {
      id: 'r1',
      createdAt: '2026-11-11T10:00:00.000Z',
      source: 'main',
      kind: 'uncaughtException',
      message: 'Error: boom at <home>/app.js',
      stack: 'Error: boom at <home>/app.js\n    at foo (<home>/app.js:10:5)',
      platform: 'linux',
      appVersion: '0.86.0-test',
      sent: false,
    },
    r2: {
      id: 'r2',
      createdAt: '2026-11-11T09:00:00.000Z',
      source: 'renderer',
      kind: 'renderer-error',
      message: 'TypeError: x is not a function',
      stack: 'TypeError: x is not a function\n    at bar (<home>/bundle.js:3:1)',
      platform: 'linux',
      sent: false,
    },
  };
}

function installMock(scenario: string): void {
  const api: Record<string, unknown> = {
    getSettings: () => Promise.resolve({ crashReportingEnabled: enabled }),
    setSettings: (patch: { crashReportingEnabled?: boolean }) => {
      if (typeof patch?.crashReportingEnabled === 'boolean') {
        enabled = patch.crashReportingEnabled;
      }
      return Promise.resolve({ crashReportingEnabled: enabled });
    },
    listCrashReports: () =>
      scenario === 'load-fails'
        ? Promise.reject(new Error('list failed'))
        : Promise.resolve(
            Object.values(REPORTS).map((r) => ({
              id: r.id,
              createdAt: r.createdAt,
              source: r.source,
              kind: r.kind,
              message: r.message,
            })),
          ),
    getCrashReport: (id: string) => {
      const doc = REPORTS[id];
      if (!doc) return Promise.reject(new Error('not found'));
      return Promise.resolve(JSON.parse(JSON.stringify(doc)));
    },
    deleteCrashReport: (id: string) => {
      delete REPORTS[id];
      return Promise.resolve({ deleted: true });
    },
    deleteAllCrashReports: () => {
      const count = Object.keys(REPORTS).length;
      REPORTS = {};
      return Promise.resolve({ deleted: count });
    },
    reportRendererError: () => Promise.resolve({ saved: false }),
  };
  (window as unknown as { openBot: unknown }).openBot = api;
}

function mountCrashReports(scenario: string): boolean {
  enabled = false;
  REPORTS = scenario === 'empty' ? {} : freshReports();
  installMock(scenario);
  const el = document.getElementById('root');
  if (!el) return false;
  if (root) {
    root.unmount();
    root = null;
  }
  root = createRoot(el);
  root.render(<CrashReportsSection />);
  return true;
}

(window as unknown as { __mountCrashReports: (s: string) => boolean }).__mountCrashReports =
  mountCrashReports;
