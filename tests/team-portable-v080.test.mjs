/**
 * Tests cho v0.80 — portable team bundle (Ưu tiên 2).
 *
 * Covers:
 *  - `buildTeamBundle` + `parseTeamBundle` round-trip (checksum khớp,
 *    serviceAccounts bị strip, teamId giữ nguyên).
 *  - Parse rejects: kind sai, version sai, checksum sai (file bị sửa),
 *    JSON hỏng, bot trùng id, skill tên xấu / trùng, trường secret
 *    (apiKey/token/password) trong data.
 *  - `checkTeamImportConflicts`: team khác id, bot/automation/skill đã
 *    có; không xung đột khi máy trống.
 *  - `summarizeTeamBundle` + `isNonEmptyTeam`.
 *
 * KHÔNG dùng CLI thật, KHÔNG gọi API ngoài, KHÔNG đọc file/key thật.
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/team-portable-v080.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TEAM_BUNDLE_KIND,
  buildTeamBundle,
  checkTeamImportConflicts,
  isNonEmptyTeam,
  parseTeamBundle,
  summarizeTeamBundle,
} from '../packages/core/dist/index.js';

const TEAM = {
  id: 'team-1',
  name: 'Đội Alpha',
  members: [{ userId: 'u1', name: 'An', role: 'admin' }],
  sharedBots: [{ botId: 'bot-a', sharedBy: 'u1' }],
  teamId: '11111111-1111-4111-8111-111111111111',
  serviceAccounts: [{ id: 'sa-22222222-2222-4222-8222-222222222222', name: 'CI', scope: 'run', createdAt: 1 }],
  workspaceDir: '/tmp/team-ws',
};

const BOTS = [
  {
    id: 'bot-a',
    name: 'Bot A',
    providerId: 'ollama',
    model: 'llama3',
    systemPrompt: 'Bạn là trợ lý.',
    workspaceDir: '/tmp/ws-a',
    autoApprove: false,
  },
];

const AUTOMATIONS = [
  {
    id: 'auto-1',
    botId: 'bot-a',
    name: 'Báo cáo sáng',
    trigger: { kind: 'interval', minutes: 60 },
    action: { kind: 'run-agent', botId: 'bot-a', prompt: 'Báo cáo' },
    enabled: true,
    createdAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:00:00.000Z',
  },
];

const SKILLS = [{ name: 'viet-bai', content: '# Viết bài\n\nHướng dẫn viết bài.' }];

function makeBundle(overrides = {}) {
  return buildTeamBundle({ team: TEAM, bots: BOTS, automations: AUTOMATIONS, skills: SKILLS, ...overrides });
}

test('build + parse round-trip: checksum khớp, serviceAccounts bị strip', () => {
  const bundle = makeBundle();
  assert.equal(bundle.kind, TEAM_BUNDLE_KIND);
  assert.equal(bundle.version, 1);
  assert.equal(bundle.teamId, TEAM.teamId);
  assert.deepEqual(bundle.data.team.serviceAccounts, [], 'service account không đi theo bundle');
  assert.equal(bundle.data.team.name, 'Đội Alpha');
  const parsed = parseTeamBundle(JSON.stringify(bundle));
  assert.deepEqual(parsed, bundle);
  const parsedAgain = parseTeamBundle(parsed);
  assert.deepEqual(parsedAgain, bundle, 'parse từ object cũng round-trip');
  const summary = summarizeTeamBundle(bundle);
  assert.deepEqual(summary, {
    teamName: 'Đội Alpha',
    teamId: TEAM.teamId,
    bots: 1,
    automations: 1,
    skills: 1,
    exportedAt: bundle.exportedAt,
  });
});

test('parse rejects: kind/version/checksum/JSON hỏng', () => {
  const bundle = makeBundle();
  assert.throws(() => parseTeamBundle(JSON.stringify({ ...bundle, kind: 'other' })), /kind phải là/);
  assert.throws(() => parseTeamBundle(JSON.stringify({ ...bundle, version: 2 })), /version phải là 1/);
  assert.throws(() => parseTeamBundle('{khong phai json'), /không phải JSON/);
  assert.throws(() => parseTeamBundle(42), /phải là một object/);
  // Sửa 1 ký tự trong data → checksum không khớp.
  const tampered = JSON.parse(JSON.stringify(bundle));
  tampered.data.bots[0].name = 'Bot X';
  assert.throws(() => parseTeamBundle(JSON.stringify(tampered)), /checksum không khớp/);
  // Sửa checksum → format sai / không khớp.
  assert.throws(() => parseTeamBundle(JSON.stringify({ ...bundle, checksum: '00' })), /checksum/);
});

test('build rejects: bot trùng id, skill tên xấu/trùng, thiếu trường', () => {
  assert.throws(() => buildTeamBundle({ team: TEAM, bots: [...BOTS, ...BOTS] }), /trùng bot id/);
  assert.throws(
    () => buildTeamBundle({ team: TEAM, bots: BOTS, skills: [{ name: 'bad name!', content: 'x' }] }),
    /tên không hợp lệ/,
  );
  assert.throws(
    () => buildTeamBundle({ team: TEAM, bots: BOTS, skills: [...SKILLS, ...SKILLS] }),
    /trùng skill/,
  );
  assert.throws(
    () => buildTeamBundle({ team: TEAM, bots: [{ ...BOTS[0], name: '' }] }),
    /thiếu tên/,
  );
  assert.throws(() => buildTeamBundle({ team: { id: 'x', name: '', members: [], sharedBots: [] }, bots: [] }), /Invalid team name/);
});

test('parse/build reject secret-looking fields', () => {
  const bundle = makeBundle();
  const evil = JSON.parse(JSON.stringify(bundle));
  evil.data.bots[0].apiKey = 'sk-secret';
  // Checksum tính lại cho đúng để chỉ còn lỗi secret bắt được.
  evil.checksum = '0'.repeat(64);
  assert.throws(() => parseTeamBundle(JSON.stringify(evil)), /trường nhạy cảm/);
  assert.throws(
    () =>
      buildTeamBundle({
        team: TEAM,
        bots: [{ ...BOTS[0], token: 'abc' }],
      }),
    /trường nhạy cảm/,
  );
});

test('checkTeamImportConflicts: máy trống thì sạch; trùng thì báo đủ loại', () => {
  const bundle = makeBundle();
  const empty = checkTeamImportConflicts(bundle, {
    teamId: '',
    teamNonEmpty: false,
    botIds: new Set(),
    automationIds: new Set(),
    skillNames: new Set(),
  });
  assert.deepEqual(empty, []);

  const full = checkTeamImportConflicts(bundle, {
    teamId: '33333333-3333-4333-8333-333333333333',
    teamNonEmpty: true,
    botIds: new Set(['bot-a', 'bot-z']),
    automationIds: new Set(['auto-1']),
    skillNames: new Set(['viet-bai']),
  });
  assert.deepEqual(
    full.map((c) => c.kind),
    ['team', 'bot', 'automation', 'skill'],
    'đủ 4 loại xung đột',
  );
  assert.match(full[0].detail, /khác team/);

  // Cùng teamId thì không xung đột team (merge được).
  const sameTeam = checkTeamImportConflicts(bundle, {
    teamId: TEAM.teamId,
    teamNonEmpty: true,
    botIds: new Set(),
    automationIds: new Set(),
    skillNames: new Set(),
  });
  assert.deepEqual(sameTeam, []);
});

test('isNonEmptyTeam: default rỗng, có member/bot là có nội dung', () => {
  assert.equal(isNonEmptyTeam({ id: 'default', name: 'Default team', members: [], sharedBots: [] }), false);
  assert.equal(
    isNonEmptyTeam({ id: 't', name: 'T', members: [], sharedBots: [], teamId: '44444444-4444-4444-8444-444444444444' }),
    true,
    'chỉ có teamId cũng tính là có nội dung',
  );
  assert.equal(isNonEmptyTeam({ id: 't', name: 'T', members: [], sharedBots: [{ botId: 'bot-a', sharedBy: '' }] }), true);
});
