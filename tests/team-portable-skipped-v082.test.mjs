/**
 * Core tests for v0.82 — team bundle skipped-skill reporting
 * (follow-up 3a).
 *
 * A skill over 200.000 chars is NOT chunked into the bundle on
 * purpose: the skill registry itself refuses to read/install any
 * SKILL.md over MAX_SKILL_TEXT_CHARS (200.000 — see
 * skills/registry.ts), so a chunked export would reassemble into a
 * file the target machine cannot load. The export skips it and
 * reports exactly why + how big it is instead.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/team-portable-skipped-v082.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TEAM_BUNDLE_MAX_SKILL_CHARS,
  buildTeamBundle,
  describeSkippedSkill,
} from '../packages/core/dist/team/portable.js';

const team = { id: 'team-1', teamId: '11111111-1111-4111-8111-111111111111', name: 'Team 1', members: [], sharedBots: [], serviceAccounts: [] };
const bot = {
  id: 'b1',
  name: 'Bot 1',
  providerId: 'mock',
  model: 'm',
  systemPrompt: 's',
  workspaceDir: '/tmp',
};

test('describeSkippedSkill: fits -> null; empty -> empty; oversize -> oversize + chars', () => {
  assert.equal(TEAM_BUNDLE_MAX_SKILL_CHARS, 200_000);
  assert.equal(describeSkippedSkill('ok', '# Skill\nhello'), null);
  assert.equal(describeSkippedSkill('edge', 'x'.repeat(200_000).replace(/^x/, '#')), null);
  assert.deepEqual(describeSkippedSkill('empty', '   \n  '), {
    name: 'empty',
    reason: 'empty',
    chars: 6,
  });
  const big = `# Big\n${'x'.repeat(200_001)}`;
  assert.deepEqual(describeSkippedSkill('big', big), {
    name: 'big',
    reason: 'oversize',
    chars: big.length,
  });
  assert.ok(big.length > 200_000);
});

test('buildTeamBundle: an oversize skill is still rejected at build/parse time', () => {
  const big = `# Big\n${'x'.repeat(200_001)}`;
  assert.throws(
    () => buildTeamBundle({ team, bots: [bot], skills: [{ name: 'big', content: big }] }),
    /vượt 200000 ký tự/,
  );
  // …while a fitting skill builds fine and round-trips.
  const bundle = buildTeamBundle({ team, bots: [bot], skills: [{ name: 'ok', content: '# Skill\nhello' }] });
  assert.equal(bundle.data.skills.length, 1);
  assert.equal(bundle.data.skills[0].name, 'ok');
});
