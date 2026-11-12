/**
 * Harness entry for tests/team-portable-v080-renderer.test.mjs.
 *
 * Bundled with esbuild and mounted in a bare Electron window — no
 * main process, no preload. `__mountTeamPortable(scenario)` mounts the
 * real `TeamView` with a mocked `window.openBot`:
 *
 * Scenarios:
 *   export          exportTeam resolves with a fake path; the test
 *                   clicks the export button and checks the notice.
 *   import-conflict importTeam resolves with one bot conflict; the
 *                   test clicks import, sees the conflict modal,
 *                   chooses "only what's new" and checks
 *                   importTeamApply was called with overwrite=false
 *                   and the "imported" notice appears.
 *
 * The mock data holds no secret and no real account. The view reads
 * the real vi.json through useT (default locale is vi), so assertions
 * check the real Vietnamese strings.
 */
import { createRoot, type Root } from 'react-dom/client';
import TeamView from '../../apps/desktop/src/renderer/components/TeamView';
import type { BotConfigLike } from '../../apps/desktop/src/renderer/types';

let root: Root | null = null;

const BOTS: BotConfigLike[] = [
  { id: 'bot-a', name: 'Bot A', providerId: 'ollama', model: 'llama3', systemPrompt: '', workspaceDir: '/tmp', autoApprove: false },
];

const TEAM = { id: 'team-1', name: 'Team 1', members: [], sharedBots: [] };

const BUNDLE = {
  kind: 'open-bot-team-bundle',
  version: 1,
  exportedAt: '2026-11-11T00:00:00.000Z',
  teamId: 'team-1',
  checksum: 'x'.repeat(64),
  data: {
    team: TEAM,
    bots: BOTS,
    automations: [{ id: 'auto-1', name: 'Auto 1' }],
    skills: [{ name: 'skill-1', content: '# Skill 1' }],
  },
};

function installMock(scenario: string): void {
  const applied: Array<{ overwrite: boolean }> = [];
  (window as unknown as { __applied: Array<{ overwrite: boolean }> }).__applied = applied;
  const api: Record<string, unknown> = {
    getTeam: () => Promise.resolve({ ...TEAM }),
    listSharedBots: () => Promise.resolve([]),
    exportTeam: () =>
      Promise.resolve({
        cancelled: false,
        path: '/tmp/open-bot-team-team-1.json',
        summary: { teamName: 'Team 1', teamId: 'team-1', bots: 1, automations: 1, skills: 1, exportedAt: '2026-11-11T00:00:00.000Z' },
        // v0.82: a skipped skill carries its reason + size, not a bare name.
        skippedSkills:
          scenario === 'export-skipped'
            ? [{ name: 'big-skill', reason: 'oversize', chars: 312450 }]
            : [],
      }),
    importTeam: () =>
      Promise.resolve({
        cancelled: false,
        path: '/tmp/open-bot-team-team-1.json',
        summary: { teamName: 'Team 1', teamId: 'team-1', bots: 1, automations: 1, skills: 1, exportedAt: '2026-11-11T00:00:00.000Z' },
        conflicts:
          scenario === 'import-conflict'
            ? [{ kind: 'bot', id: 'bot-a', detail: 'Bot bot-a đã có (Bot A)' }]
            : [],
        bundle: BUNDLE,
      }),
    importTeamApply: ({ overwrite }: { overwrite: boolean }) => {
      applied.push({ overwrite });
      return Promise.resolve({
        report: {
          teamChanged: false,
          botsAdded: 0,
          botsReplaced: 0,
          botsSkipped: 1,
          automationsAdded: 1,
          automationsReplaced: 0,
          automationsSkipped: 0,
          skillsWritten: 1,
          skillsSkipped: 0,
          webhookDisabled: 0,
        },
        skipped: [{ kind: 'bot', id: 'bot-a', reason: 'đã có' }],
        webhookDisabledIds: [],
        failures: [],
      });
    },
  };
  (window as unknown as { openBot: unknown }).openBot = api;
}

function mountTeamPortable(scenario: string): boolean {
  installMock(scenario);
  const el = document.getElementById('root');
  if (!el) return false;
  if (root) {
    root.unmount();
    root = null;
  }
  root = createRoot(el);
  root.render(<TeamView bots={BOTS} onBack={() => undefined} />);
  return true;
}

(window as unknown as { __mountTeamPortable: (s: string) => boolean }).__mountTeamPortable = mountTeamPortable;
