/**
 * Tests cho v0.80 — apply decisions của portable team bundle
 * (`apps/desktop/src/main/teamPortable.ts`, pure, không Electron).
 *
 * Covers:
 *  - Team rỗng → adopt nguyên bundle team; team cùng teamId → merge
 *    (union member/sharedBot, bundle thắng cùng id, giữ workspaceDir
 *    local); team khác id → không overwrite thì skip team, có overwrite
 *    thì thay team (serviceAccounts local luôn được giữ).
 *  - Bot/automation/skill: id mới → add, id trùng → skip (không
 *    overwrite) / replace (có overwrite).
 *  - Automation gọi bot không có → skip; automation webhook → import
 *    ở trạng thái TẮT (key không đi theo file); lastRunAt/nextRunAt
 *    reset.
 *
 * Run: node --test tests/team-portable-apply-v080.test.mjs
 * (cần packages/core/dist đã build.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTeamBundle } from '../packages/core/dist/index.js';
import { planTeamImport } from '../apps/desktop/src/main/teamPortable.ts';

const TEAM_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TEAM_ID = '22222222-2222-4222-8222-222222222222';

const BUNDLE_TEAM = {
  id: 'team-1',
  name: 'Đội Alpha',
  members: [{ userId: 'u1', name: 'An', role: 'admin' }],
  sharedBots: [{ botId: 'bot-a', sharedBy: 'u1' }],
  teamId: TEAM_ID,
  workspaceDir: '/tmp/team-ws',
};

const BOT_A = {
  id: 'bot-a',
  name: 'Bot A',
  providerId: 'ollama',
  model: 'llama3',
  systemPrompt: 'Hi',
  workspaceDir: '/tmp/ws-a',
  autoApprove: false,
};

const AUTO_RUN = {
  id: 'auto-1',
  botId: 'bot-a',
  name: 'Báo cáo sáng',
  trigger: { kind: 'interval', minutes: 60 },
  action: { kind: 'run-agent', botId: 'bot-a', prompt: 'Báo cáo' },
  enabled: true,
  createdAt: '2026-11-11T00:00:00.000Z',
  updatedAt: '2026-11-11T00:00:00.000Z',
};

const AUTO_WEBHOOK = {
  id: 'auto-2',
  botId: 'bot-a',
  name: 'Nhận webhook',
  trigger: { kind: 'webhook', keyId: 'auto-2' },
  action: { kind: 'notify', message: 'Có webhook' },
  enabled: true,
  createdAt: '2026-11-11T00:00:00.000Z',
  updatedAt: '2026-11-11T00:00:00.000Z',
};

const AUTO_GHOST_BOT = {
  id: 'auto-3',
  botId: 'bot-a',
  name: 'Gọi bot ma',
  trigger: { kind: 'manual' },
  action: { kind: 'run-agent', botId: 'bot-khong-co', prompt: 'Làm đi' },
  enabled: true,
  createdAt: '2026-11-11T00:00:00.000Z',
  updatedAt: '2026-11-11T00:00:00.000Z',
};

function makeBundle() {
  return buildTeamBundle({
    team: BUNDLE_TEAM,
    bots: [BOT_A],
    automations: [AUTO_RUN, AUTO_WEBHOOK, AUTO_GHOST_BOT],
    skills: [{ name: 'viet-bai', content: '# Viết bài\n\nHướng dẫn.' }],
  });
}

const EMPTY_TEAM = { id: 'default', name: 'Default team', members: [], sharedBots: [] };

test('plan: team rỗng adopt nguyên bundle; webhook tắt; automation gọi bot ma bị skip', () => {
  const plan = planTeamImport({
    currentTeam: EMPTY_TEAM,
    currentBots: [],
    currentAutomations: [],
    currentSkillNames: [],
    bundle: makeBundle(),
    overwrite: false,
  });
  assert.equal(plan.team.name, 'Đội Alpha');
  assert.equal(plan.team.teamId, TEAM_ID);
  assert.equal(plan.report.teamChanged, true);
  assert.deepEqual(plan.botsToAdd.map((b) => b.id), ['bot-a']);
  assert.deepEqual(plan.automationsToAdd.map((a) => a.id), ['auto-1', 'auto-2']);
  const webhook = plan.automationsToAdd.find((a) => a.id === 'auto-2');
  assert.equal(webhook.enabled, false, 'webhook import ở trạng thái tắt');
  assert.equal(webhook.lastRunAt, null);
  assert.deepEqual(plan.webhookDisabledIds, ['auto-2']);
  assert.deepEqual(plan.skillsToWrite.map((s) => s.name), ['viet-bai']);
  assert.deepEqual(
    plan.skipped.map((s) => s.id),
    ['auto-3'],
    'chỉ automation gọi bot ma bị skip',
  );
  assert.equal(plan.report.automationsSkipped, 1);
  assert.equal(plan.report.webhookDisabled, 1);
});

test('plan: trùng id thì skip khi không overwrite, replace khi overwrite', () => {
  const base = {
    currentTeam: { ...BUNDLE_TEAM, teamId: TEAM_ID, members: [{ userId: 'u1', name: 'An', role: 'admin' }] },
    currentBots: [{ ...BOT_A, name: 'Bot A (cũ)' }],
    currentAutomations: [{ ...AUTO_RUN, name: 'Báo cáo (cũ)' }],
    currentSkillNames: ['viet-bai'],
    bundle: makeBundle(),
    overwrite: false,
  };
  const noOverwrite = planTeamImport(base);
  assert.deepEqual(noOverwrite.botsToAdd, []);
  assert.deepEqual(noOverwrite.botsToReplace, []);
  assert.deepEqual(noOverwrite.automationsToReplace, []);
  assert.deepEqual(noOverwrite.skillsToWrite, []);
  assert.deepEqual(
    noOverwrite.skipped.map((s) => `${s.kind}:${s.id}`).sort(),
    ['automation:auto-1', 'automation:auto-3', 'bot:bot-a', 'skill:viet-bai'],
    'auto-3 (gọi bot ma) cũng bị skip',
  );
  // Team cùng id → merge, không tính là skip.
  assert.equal(noOverwrite.team.name, 'Đội Alpha');
  assert.equal(noOverwrite.skipped.some((s) => s.kind === 'team'), false);

  const withOverwrite = planTeamImport({ ...base, overwrite: true });
  assert.deepEqual(withOverwrite.botsToReplace.map((b) => b.name), ['Bot A']);
  assert.deepEqual(withOverwrite.automationsToReplace.map((a) => a.name), ['Báo cáo sáng']);
  assert.deepEqual(withOverwrite.skillsToWrite.map((s) => s.name), ['viet-bai']);
  assert.deepEqual(withOverwrite.skipped.map((s) => s.id), ['auto-3'], 'chỉ còn automation bot ma bị skip');
  assert.equal(withOverwrite.report.botsReplaced, 1);
  assert.equal(withOverwrite.report.automationsReplaced, 1);
});

test('plan: team khác id — không overwrite thì giữ team cũ, overwrite thì thay team', () => {
  const localTeam = {
    id: 'team-9',
    name: 'Đội Beta',
    members: [{ userId: 'u9', name: 'Bình', role: 'admin' }],
    sharedBots: [{ botId: 'bot-z', sharedBy: 'u9' }],
    teamId: OTHER_TEAM_ID,
    serviceAccounts: [{ id: 'sa-33333333-3333-4333-8333-333333333333', name: 'CI Beta', scope: 'run', createdAt: 1 }],
  };
  const base = {
    currentTeam: localTeam,
    currentBots: [],
    currentAutomations: [],
    currentSkillNames: [],
    bundle: makeBundle(),
    overwrite: false,
  };
  const kept = planTeamImport(base);
  assert.equal(kept.team.name, 'Đội Beta', 'team cũ được giữ');
  assert.equal(kept.skipped.some((s) => s.kind === 'team'), true);
  assert.equal(kept.report.teamChanged, false);
  // Bot vẫn được nhập (chỉ team là xung đột) — bot không thuộc team cũ.
  assert.deepEqual(kept.botsToAdd.map((b) => b.id), ['bot-a']);

  const replaced = planTeamImport({ ...base, overwrite: true });
  assert.equal(replaced.team.name, 'Đội Alpha');
  assert.equal(replaced.team.teamId, TEAM_ID);
  assert.deepEqual(replaced.team.serviceAccounts, localTeam.serviceAccounts, 'service account local được giữ kể cả khi thay team');
  assert.equal(replaced.skipped.some((s) => s.kind === 'team'), false);
});

test('plan: merge cùng teamId — union member/sharedBot, giữ workspaceDir local', () => {
  const localTeam = {
    id: 'team-1',
    name: 'Đội Alpha (cũ)',
    members: [{ userId: 'u9', name: 'Bình', role: 'member' }],
    sharedBots: [{ botId: 'bot-z', sharedBy: 'u9' }],
    teamId: TEAM_ID,
    workspaceDir: '/tmp/local-ws',
  };
  const plan = planTeamImport({
    currentTeam: localTeam,
    currentBots: [],
    currentAutomations: [],
    currentSkillNames: [],
    bundle: makeBundle(),
    overwrite: false,
  });
  assert.deepEqual(
    plan.team.members.map((m) => m.userId).sort(),
    ['u1', 'u9'],
    'member hai bên đều giữ',
  );
  assert.deepEqual(
    plan.team.sharedBots.map((b) => b.botId).sort(),
    ['bot-a', 'bot-z'],
  );
  assert.equal(plan.team.workspaceDir, '/tmp/local-ws', 'workspaceDir local được giữ');
  assert.equal(plan.team.name, 'Đội Alpha', 'tên lấy theo bundle');
});
