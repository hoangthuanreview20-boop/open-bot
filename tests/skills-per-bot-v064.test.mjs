/**
 * Tests cho v0.64 (skills per-bot) — bật/tắt skill theo bot, tương tự
 * denyTools của v0.59 (UI-3) nhưng cho skill.
 *
 * Core (coordinator RPC `listBotSkills` / `setBotSkillEnabled`):
 *   1. listBotSkills: 3 skill built-in, bật hết mặc định, đủ trường
 *      (name / description / context / allowedTools / enabled /
 *      globallyEnabled).
 *   2. setBotSkillEnabled: tắt/bật một skill — enabled đổi đúng,
 *      denySkills trả về đúng; skill khác không bị ảnh hưởng.
 *   3. Persist qua BotConfig: tạo bot với denySkills sẵn thì list
 *      hiện tắt ngay (đường main persist `BotConfig.denySkills` rồi
 *      `createBot` đăng ký vào policy — xem coordinator.ts).
 *   4. Filter trong turn thật: skill đã tắt không tới được model —
 *      mock ghi lại request (`mockRecordPath`): không có trong index
 *      tier 1, không nạp body tier 2, không thu hẹp tool; skill khác
 *      vẫn match + nạp body bình thường.
 *   5. Fork skill (`context: fork`): tắt thì không fork (không có
 *      tên/body/summary trong prompt); bật thì vẫn thấy trong index.
 *   6. deny rỗng / không đặt = như cũ: đủ 3 skill trong index, skill
 *      khớp vẫn nạp body.
 *   7. Pure helpers (agent/permissions.ts): `isSkillAllowedFor` /
 *      `filterSkillsFor` / `AgentPermissions` (deny thắng, bot khác
 *      không bị ảnh hưởng) + `sanitizeDenySkills` (chỉ nhận mảng
 *      chuỗi; tên lạ / phần tử lạ thì bỏ qua, không throw cả lệnh;
 *      không phải mảng thì throw).
 *   8. Lỗi rõ ràng: bot lạ / skill lạ → reject, không đổi gì;
 *      registry chưa dựng thì listBotSkills trả rỗng, không throw.
 *
 * Chạy sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/skills-per-bot-v064.test.mjs
 *
 * Không mạng thật, không key thật, không tài khoản thật.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentCoordinator } from '../packages/core/dist/index.js';
import {
  AgentPermissions,
  filterSkillsFor,
  isSkillAllowedFor,
  sanitizeDenySkills,
} from '../packages/core/dist/agent/permissions.js';

const tmpDirs = [];
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function botConfig(id, workspaceDir, extra = {}) {
  return {
    id,
    name: `Bot ${id}`,
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'You are a test bot.',
    workspaceDir,
    autoApprove: true,
    ...extra,
  };
}

function mockProviderConfig(recordPath) {
  return {
    id: 'mock',
    label: 'Mock',
    defaultModel: 'mock',
    mockResponses: [{ text: 'ok' }],
    ...(recordPath ? { mockRecordPath: recordPath } : {}),
  };
}

/** One user skill with `context: fork`, written before createBot. */
const FORK_SKILL_MD = `---
name: fork-note
description: Take a note in a separate subagent.
version: 1.0.0
when-to-use: when the user asks to zebrafork something
allowed-tools: [web_search]
context: fork
---
# Fork note
FORK-NOTE-BODY-MARKER: take the zebrafork note here.
`;

async function makeBot(extraBot = {}, recordPath, withForkSkill = false) {
  const ws = tmpDir('open-bot-skills-perbot-ws-');
  if (withForkSkill) {
    const dir = path.join(ws, 'skills', 'fork-note');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), FORK_SKILL_MD, 'utf8');
  }
  const coord = new AgentCoordinator({ dataDir: tmpDir('open-bot-skills-perbot-data-') });
  await coord.createBot({
    bot: botConfig('bot-1', ws, extraBot),
    provider: mockProviderConfig(recordPath),
    skillsDirs: {
      userSkillsDir: path.join(ws, 'skills'),
      pluginsDir: path.join(ws, 'plugins'),
      stateDir: ws,
    },
  });
  return { coord, ws };
}

function byName(skills, name) {
  const skill = skills.find((s) => s.name === name);
  assert.ok(skill, `skill ${name} phải có trong danh sách`);
  return skill;
}

/** First ChatCompletionRequest recorded by the mock provider. */
function firstRecord(recordPath) {
  const lines = fs.readFileSync(recordPath, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(lines.length >= 1, 'mock provider phải ghi ít nhất 1 request');
  return JSON.parse(lines[0]);
}

function systemPromptOf(req) {
  const sys = req.messages.find((m) => m.role === 'system');
  assert.ok(sys, 'request phải có message system');
  return sys.content;
}

// Body markers — text that ONLY appears in one built-in skill's body.
const BODY_MARKERS = {
  'code-review': 'Read the changed files',
  'research-brief': 'TL;DR',
  'writing-vi': 'Sound like a person',
};

test('listBotSkills: 8 skill built-in, bật hết mặc định, đủ trường', async () => {
  const { coord } = await makeBot();
  try {
    const result = await coord.handle('listBotSkills', { botId: 'bot-1' });
    assert.equal(result.botId, 'bot-1');
    assert.equal(result.totalSkills, 8, `cần 8 skill built-in, có ${result.totalSkills}`);
    assert.equal(result.skills.length, result.totalSkills);
    assert.equal(result.enabledSkills, result.totalSkills, 'mặc định bật hết');

    for (const name of [
      'code-review',
      'research-brief',
      'writing-vi',
      'git-workflow',
      'test-writing',
      'data-cleaning',
      'meeting-notes',
      'translation',
    ]) {
      const skill = byName(result.skills, name);
      assert.ok(skill.description.length > 0, `${name}: phải có mô tả`);
      assert.equal(skill.context, 'inline', `${name}: built-in chạy inline`);
      assert.ok(Array.isArray(skill.allowedTools));
      assert.equal(skill.enabled, true);
      assert.equal(skill.globallyEnabled, true);
    }
    assert.deepEqual(byName(result.skills, 'code-review').allowedTools, [
      'read_file',
      'grep_search',
      'git_diff',
    ]);
  } finally {
    coord.shutdown();
  }
});

test('setBotSkillEnabled: tắt/bật đổi enabled + denySkills đúng', async () => {
  const { coord } = await makeBot();
  try {
    const off = await coord.handle('setBotSkillEnabled', {
      botId: 'bot-1',
      skillName: 'code-review',
      enabled: false,
    });
    assert.equal(off.enabled, false);
    assert.deepEqual(off.denySkills, ['code-review']);

    const afterOff = await coord.listBotSkills({ botId: 'bot-1' });
    assert.equal(byName(afterOff.skills, 'code-review').enabled, false);
    assert.equal(afterOff.enabledSkills, afterOff.totalSkills - 1);
    // Skill khác không bị ảnh hưởng.
    assert.equal(byName(afterOff.skills, 'research-brief').enabled, true);
    assert.equal(byName(afterOff.skills, 'writing-vi').enabled, true);

    const on = await coord.setBotSkillEnabled({
      botId: 'bot-1',
      skillName: 'code-review',
      enabled: true,
    });
    assert.equal(on.enabled, true);
    assert.deepEqual(on.denySkills, []);
    const afterOn = await coord.listBotSkills({ botId: 'bot-1' });
    assert.equal(afterOn.enabledSkills, afterOn.totalSkills);
  } finally {
    coord.shutdown();
  }
});

test('denySkills từ BotConfig: tạo bot đã tắt sẵn thì list hiện tắt (persist path)', async () => {
  const { coord } = await makeBot({ denySkills: ['code-review', 'writing-vi'] });
  try {
    const result = await coord.listBotSkills({ botId: 'bot-1' });
    assert.equal(byName(result.skills, 'code-review').enabled, false);
    assert.equal(byName(result.skills, 'writing-vi').enabled, false);
    assert.equal(byName(result.skills, 'research-brief').enabled, true);
    assert.equal(result.enabledSkills, result.totalSkills - 2);
    // Bật lại qua RPC thì policy live đổi theo.
    await coord.setBotSkillEnabled({ botId: 'bot-1', skillName: 'code-review', enabled: true });
    const after = await coord.listBotSkills({ botId: 'bot-1' });
    assert.equal(byName(after.skills, 'code-review').enabled, true);
    assert.equal(byName(after.skills, 'writing-vi').enabled, false);
  } finally {
    coord.shutdown();
  }
});

test('filter trong turn thật: skill đã tắt không tới được model, skill khác vẫn chạy', async () => {
  const recordPath = path.join(tmpDir('open-bot-skills-perbot-rec-'), 'requests.jsonl');
  const { coord } = await makeBot({ denySkills: ['code-review'] }, recordPath);
  try {
    // Turn khớp code-review nhưng skill đã tắt: không index, không body,
    // không thu hẹp tool (write_file vẫn được gửi — ngược với run có
    // skill khớp, xem skills-coordinator.test.mjs).
    await coord.run({ botId: 'bot-1', text: 'review code trong pull request này giúp tôi' });
    let prompt = systemPromptOf(firstRecord(recordPath));
    assert.doesNotMatch(prompt, /code-review/, 'skill đã tắt không được vào index tier 1');
    assert.doesNotMatch(
      prompt,
      new RegExp(BODY_MARKERS['code-review']),
      'skill đã tắt không được nạp body tier 2',
    );
    assert.match(prompt, /research-brief/, 'skill khác vẫn còn trong index');
    assert.match(prompt, /writing-vi/, 'skill khác vẫn còn trong index');
    assert.ok(
      JSON.stringify(firstRecord(recordPath).tools).includes('write_file'),
      'skill đã tắt không được thu hẹp tool của turn',
    );

    // Turn khớp research-brief (không bị tắt): body vẫn nạp bình thường.
    await coord.run({ botId: 'bot-1', text: 'research the history of the transistor and write a brief' });
    const lines = fs.readFileSync(recordPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 2, 'turn thứ hai ghi thêm một request');
    prompt = systemPromptOf(JSON.parse(lines[1]));
    assert.match(prompt, new RegExp(BODY_MARKERS['research-brief']), 'skill không bị tắt vẫn nạp body');
    assert.doesNotMatch(prompt, /code-review/, 'skill đã tắt vẫn vắng ở turn sau');
  } finally {
    coord.shutdown();
  }
});

test('fork skill: tắt thì không fork, bật thì vẫn thấy trong index', async () => {
  const recordPath = path.join(tmpDir('open-bot-skills-perbot-rec-'), 'requests.jsonl');
  const { coord } = await makeBot({}, recordPath, true);
  try {
    const listed = await coord.listBotSkills({ botId: 'bot-1' });
    assert.equal(byName(listed.skills, 'fork-note').context, 'fork');
    assert.equal(byName(listed.skills, 'fork-note').enabled, true);

    // Bật: run khớp task thì tên skill xuất hiện trong prompt (index
    // tier 1, và/hoặc summary sau khi fork chạy xong). Fork chạy trong
    // subagent riêng nên mock ghi 2 request: 1 của fork + 1 của run
    // cha — request của cha luôn là dòng CUỐI.
    await coord.run({ botId: 'bot-1', text: 'please zebrafork the quarterly plan' });
    let lines = fs.readFileSync(recordPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 2, 'run có fork skill phải ghi 2 request (fork + cha)');
    let prompt = systemPromptOf(JSON.parse(lines[lines.length - 1]));
    assert.match(prompt, /fork-note/, 'skill fork đang bật phải xuất hiện trong prompt');

    // Tắt live qua RPC rồi chạy lại: tên + body đều biến mất — không
    // index, không body, không fork summary — và chỉ ghi thêm đúng 1
    // request (không còn fork chạy nữa).
    await coord.setBotSkillEnabled({ botId: 'bot-1', skillName: 'fork-note', enabled: false });
    await coord.run({ botId: 'bot-1', text: 'please zebrafork the quarterly plan again' });
    lines = fs.readFileSync(recordPath, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 3, 'run sau khi tắt fork skill chỉ ghi thêm 1 request (không fork)');
    prompt = systemPromptOf(JSON.parse(lines[lines.length - 1]));
    assert.doesNotMatch(prompt, /fork-note/, 'skill fork đã tắt không được vào prompt');
    assert.doesNotMatch(prompt, /FORK-NOTE-BODY-MARKER/, 'skill fork đã tắt không được nạp body');
  } finally {
    coord.shutdown();
  }
});

test('deny rỗng / không đặt = như cũ: đủ index, skill khớp vẫn nạp body', async () => {
  const recordPath = path.join(tmpDir('open-bot-skills-perbot-rec-'), 'requests.jsonl');
  const { coord } = await makeBot({ denySkills: [] }, recordPath);
  try {
    await coord.run({ botId: 'bot-1', text: 'review code trong pull request này giúp tôi' });
    const prompt = systemPromptOf(firstRecord(recordPath));
    for (const name of ['code-review', 'research-brief', 'writing-vi']) {
      assert.match(prompt, new RegExp(name), `index phải còn ${name} khi deny rỗng`);
    }
    assert.match(prompt, new RegExp(BODY_MARKERS['code-review']), 'skill khớp vẫn nạp body');
  } finally {
    coord.shutdown();
  }
});

test('permissions pure: isSkillAllowedFor / filterSkillsFor / AgentPermissions', () => {
  // Không policy = cho phép hết.
  assert.equal(isSkillAllowedFor(undefined, 'code-review'), true);
  assert.deepEqual(filterSkillsFor(undefined, [{ name: 'a' }, { name: 'b' }]).map((s) => s.name), [
    'a',
    'b',
  ]);
  // Deny thắng, chỉ skill bị deny mới rớt, thứ tự còn lại giữ nguyên.
  const policy = { denySkills: ['code-review'] };
  assert.equal(isSkillAllowedFor(policy, 'code-review'), false);
  assert.equal(isSkillAllowedFor(policy, 'research-brief'), true);
  assert.deepEqual(
    filterSkillsFor(policy, [{ name: 'code-review' }, { name: 'research-brief' }]).map((s) => s.name),
    ['research-brief'],
  );
  // Instance: bot khác không bị ảnh hưởng (registry dùng chung không đổi).
  const perms = new AgentPermissions();
  perms.setBotPolicy('bot-a', { denySkills: ['code-review'] });
  perms.setBotPolicy('bot-b', {});
  assert.equal(perms.isSkillAllowed('bot-a', 'code-review'), false);
  assert.equal(perms.isSkillAllowed('bot-b', 'code-review'), true);
  assert.equal(perms.isSkillAllowed('bot-chua-co', 'code-review'), true);
  assert.deepEqual(
    perms.filterSkills('bot-a', [{ name: 'code-review' }, { name: 'writing-vi' }]).map((s) => s.name),
    ['writing-vi'],
  );
  // setBotPolicy copy mảng (đổi mảng gốc sau đó không rò vào policy).
  const deny = ['research-brief'];
  perms.setBotPolicy('bot-c', { denySkills: deny });
  deny.push('writing-vi');
  assert.equal(perms.isSkillAllowed('bot-c', 'writing-vi'), true);
});

test('sanitizeDenySkills: chỉ nhận mảng chuỗi, tên lạ thì bỏ qua không throw', () => {
  const known = ['code-review', 'research-brief', 'writing-vi'];
  // Giữ tên quen, bỏ tên lạ, bỏ phần tử không phải chuỗi, bỏ trùng/lặp khoảng trắng.
  assert.deepEqual(sanitizeDenySkills(['code-review', 'skill-la', 42, null, ' code-review ', ''], known), {
    kept: ['code-review'],
    dropped: ['skill-la', '42', 'null'],
  });
  assert.deepEqual(sanitizeDenySkills([], known), { kept: [], dropped: [] });
  // Không phải mảng thì throw (lỗi kiểu — khác với tên lạ).
  assert.throws(() => sanitizeDenySkills('code-review', known), /mảng chuỗi/);
  assert.throws(() => sanitizeDenySkills(undefined, known), /mảng chuỗi/);
  assert.throws(() => sanitizeDenySkills({ 'code-review': true }, known), /mảng chuỗi/);
});

test('listBotSkills / setBotSkillEnabled: bot lạ / skill lạ thì lỗi rõ ràng', async () => {
  const { coord } = await makeBot();
  try {
    // listBotSkills / setBotSkillEnabled là hàm đồng bộ (throw trực
    // tiếp) nên phải bọc trong async arrow cho assert.rejects.
    await assert.rejects(
      async () => coord.listBotSkills({ botId: 'bot-khong-co' }),
      /Chưa tạo bot/,
    );
    await assert.rejects(
      async () =>
        coord.setBotSkillEnabled({ botId: 'bot-1', skillName: 'skill_khong_co', enabled: false }),
      /không có skill/,
    );
    await assert.rejects(
      coord.handle('setBotSkillEnabled', { botId: 'bot-1', skillName: 'code-review', enabled: 'yes' }),
      /cần params/,
    );
    // Lỗi không làm đổi trạng thái skill thật.
    const after = await coord.listBotSkills({ botId: 'bot-1' });
    assert.equal(byName(after.skills, 'code-review').enabled, true);
  } finally {
    coord.shutdown();
  }
});

test('listBotSkills: registry chưa dựng thì trả rỗng, không throw', async () => {
  const ws = tmpDir('open-bot-skills-perbot-ws-');
  const coord = new AgentCoordinator({ dataDir: tmpDir('open-bot-skills-perbot-data-') });
  try {
    await coord.createBot({
      bot: botConfig('bot-1', ws),
      provider: mockProviderConfig(),
      // Không truyền skillsDirs: registry chưa dựng.
    });
    const result = await coord.listBotSkills({ botId: 'bot-1' });
    assert.deepEqual(result, { botId: 'bot-1', skills: [], totalSkills: 0, enabledSkills: 0 });
  } finally {
    coord.shutdown();
  }
});
