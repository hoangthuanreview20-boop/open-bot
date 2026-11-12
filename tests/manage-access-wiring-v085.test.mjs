/**
 * Tests cho v0.85 (P1-7) — nối `isTeamAdmin` cho `manage_access`.
 *
 * Trước v0.85, tool `manage_access` đã có guard 3 lớp nhưng callback
 * `isAdmin` do host cấu hình chưa bao giờ được nối: `defaultToolFactory`
 * đọc `host.isTeamAdmin` nhưng `buildToolHost` không truyền gì, và
 * tiến trình coordinator con (do desktop main spawn) cũng không dựng
 * callback — mọi mutation đều bị từ chối fail-closed, chỉ còn list.
 *
 * Nối dây v0.85 (3 tầng):
 *  1. `CoordinatorOptions.isTeamAdmin` / `getTeamBaseDir` → constructor
 *     lưu lại → `buildToolHost` chuyển vào `defaultToolFactory`.
 *  2. `runCoordinatorStdio` dựng 2 callback từ env main truyền khi
 *     spawn (`OPENBOT_DATA_DIR` + `OPENBOT_LOCAL_USER_ID`): role đọc
 *     LIVE từ team.json mỗi lần check (`isLocalUserTeamAdmin`).
 *  3. `main.ts` `getCoordinator` truyền `OPENBOT_LOCAL_USER_ID` khi
 *     spawn (cùng `OPENBOT_DATA_DIR` đã có từ v0.35).
 *
 * Chạy sau khi build core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/manage-access-wiring-v085.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentCoordinator } from '../packages/core/dist/index.js';
import { CoordinatorClient } from '../packages/core/dist/coordinator/client.js';
import {
  addMember,
  defaultTeamConfig,
  isLocalUserTeamAdmin,
  loadTeamConfig,
  saveTeamConfig,
  setRole,
} from '../packages/core/dist/team/team.js';
import { LOCAL_USER_ID } from '../packages/core/dist/team/types.js';

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

function botConfig(id, workspaceDir) {
  return {
    id,
    name: `Bot ${id}`,
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'You are a test bot.',
    workspaceDir,
    autoApprove: true,
  };
}

function mockProvider(text) {
  return { id: 'mock', label: 'Mock', mockResponses: [{ text }] };
}

/** Team có user local với role cho trước (+ 1 member khác để list có nội dung). */
function teamWithLocalRole(role) {
  let team = defaultTeamConfig();
  team = addMember(team, { userId: LOCAL_USER_ID, name: 'Owner', role });
  team = addMember(team, { userId: 'teammate', name: 'Teammate', role: 'member' });
  return team;
}

/**
 * Coordinator in-process với đúng 2 callback mà `runCoordinatorStdio`
 * dựng (đọc team.json live dưới dataDir, user local = LOCAL_USER_ID).
 */
async function makeWiredCoordinator(team) {
  const dataDir = tmpDir('open-bot-manage-access-data-');
  const ws = tmpDir('open-bot-manage-access-ws-');
  if (team) saveTeamConfig(dataDir, team);
  const coord = new AgentCoordinator({
    dataDir,
    getTeamBaseDir: () => dataDir,
    isTeamAdmin: () => isLocalUserTeamAdmin(dataDir, LOCAL_USER_ID),
  });
  await coord.createBot({ bot: botConfig('bot-1', ws), provider: mockProvider('ok') });
  return { coord, dataDir, ws };
}

async function runManageAccess(coord, args) {
  const res = await coord.runTool({ botId: 'bot-1', tool: 'manage_access', args });
  return res.output;
}

test('P1-7: admin đổi quyền được (add_member ghi team.json)', async () => {
  const { coord, dataDir } = await makeWiredCoordinator(teamWithLocalRole('admin'));
  try {
    const out = await runManageAccess(coord, {
      action: 'add_member',
      user_id: 'newbie',
      name: 'Newbie',
      role: 'viewer',
    });
    assert.match(out, /Added member "newbie"/);
    const team = loadTeamConfig(dataDir);
    assert.equal(team.members.find((m) => m.userId === 'newbie')?.role, 'viewer');
    // set_role cũng đi qua cùng guard.
    const renamed = await runManageAccess(coord, {
      action: 'set_role',
      user_id: 'newbie',
      role: 'member',
    });
    assert.match(renamed, /is now "member"/);
    assert.equal(loadTeamConfig(dataDir).members.find((m) => m.userId === 'newbie')?.role, 'member');
  } finally {
    coord.shutdown();
  }
});

test('P1-7: non-admin đổi quyền bị từ chối fail-closed, list vẫn được', async () => {
  const { coord, dataDir } = await makeWiredCoordinator(teamWithLocalRole('member'));
  try {
    const out = await runManageAccess(coord, {
      action: 'add_member',
      user_id: 'newbie',
      name: 'Newbie',
      role: 'viewer',
    });
    assert.match(out, /^Error:/);
    assert.match(out, /không phải admin/);
    // team.json không đổi: không thêm ai.
    assert.equal(loadTeamConfig(dataDir).members.find((m) => m.userId === 'newbie'), undefined);
    // Hành động chỉ-đọc vẫn được cho mọi người.
    const listed = await runManageAccess(coord, { action: 'list_members' });
    assert.match(listed, /teammate/);
    assert.match(listed, new RegExp(LOCAL_USER_ID));
  } finally {
    coord.shutdown();
  }
});

test('P1-7: không có isTeamAdmin → mutation bị từ chối (fail-closed, hành vi cũ)', async () => {
  const dataDir = tmpDir('open-bot-manage-access-data-');
  const ws = tmpDir('open-bot-manage-access-ws-');
  saveTeamConfig(dataDir, teamWithLocalRole('admin'));
  // Không có getTeamBaseDir, tool đọc team.json mặc định dưới workspace
  // (<workspaceDir>/.open-bot/team) — ghi team vào đúng chỗ đó để
  // list_members đọc được (mutation vẫn bị từ chối vì thiếu isAdmin).
  saveTeamConfig(path.join(ws, '.open-bot', 'team'), teamWithLocalRole('admin'));
  const coord = new AgentCoordinator({ dataDir });
  try {
    await coord.createBot({ bot: botConfig('bot-1', ws), provider: mockProvider('ok') });
    const out = await runManageAccess(coord, {
      action: 'add_member',
      user_id: 'newbie',
      name: 'Newbie',
      role: 'viewer',
    });
    assert.match(out, /^Error:/);
    assert.match(out, /chưa được cấu hình kiểm tra quản trị/);
    assert.equal(loadTeamConfig(dataDir).members.find((m) => m.userId === 'newbie'), undefined);
    // List vẫn được dù không có callback admin.
    const listed = await runManageAccess(coord, { action: 'list_members' });
    assert.match(listed, /teammate/);
  } finally {
    coord.shutdown();
  }
});

test('P1-7: đổi role lúc chạy có hiệu lực ngay, không cần tạo lại bot', async () => {
  const { coord, dataDir } = await makeWiredCoordinator(teamWithLocalRole('member'));
  try {
    const denied = await runManageAccess(coord, {
      action: 'add_member',
      user_id: 'newbie',
      name: 'Newbie',
      role: 'viewer',
    });
    assert.match(denied, /không phải admin/);
    // Admin UI đổi role (ghi team.json trực tiếp, như team:set-role).
    saveTeamConfig(dataDir, setRole(loadTeamConfig(dataDir), LOCAL_USER_ID, 'admin'));
    const allowed = await runManageAccess(coord, {
      action: 'add_member',
      user_id: 'newbie',
      name: 'Newbie',
      role: 'viewer',
    });
    assert.match(allowed, /Added member "newbie"/);
  } finally {
    coord.shutdown();
  }
});

test('P1-7: isLocalUserTeamAdmin — single-user / viewer / file hỏng', () => {
  // Không có team.json: install single-user → owner không bị giới hạn.
  const emptyDir = tmpDir('open-bot-manage-access-empty-');
  assert.equal(isLocalUserTeamAdmin(emptyDir), true);
  // Viewer không phải admin.
  const viewerDir = tmpDir('open-bot-manage-access-viewer-');
  saveTeamConfig(viewerDir, teamWithLocalRole('viewer'));
  assert.equal(isLocalUserTeamAdmin(viewerDir), false);
  // Member không phải admin; admin thì được.
  const memberDir = tmpDir('open-bot-manage-access-member-');
  saveTeamConfig(memberDir, teamWithLocalRole('member'));
  assert.equal(isLocalUserTeamAdmin(memberDir), false);
  const adminDir = tmpDir('open-bot-manage-access-admin-');
  saveTeamConfig(adminDir, teamWithLocalRole('admin'));
  assert.equal(isLocalUserTeamAdmin(adminDir), true);
  // team.json hỏng → fail-closed (không bao giờ âm thầm cho admin).
  const brokenDir = tmpDir('open-bot-manage-access-broken-');
  fs.mkdirSync(brokenDir, { recursive: true });
  fs.writeFileSync(path.join(brokenDir, 'team.json'), '{ khong-phai-json', 'utf8');
  assert.equal(isLocalUserTeamAdmin(brokenDir), false);
});

test('P1-7: coordinator con thật (stdio, như main spawn) — admin đổi quyền được', async () => {
  const dataDir = tmpDir('open-bot-manage-access-child-');
  const ws = tmpDir('open-bot-manage-access-child-ws-');
  saveTeamConfig(dataDir, teamWithLocalRole('admin'));
  const client = new CoordinatorClient({
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      OPENBOT_DATA_DIR: dataDir,
      OPENBOT_LOCAL_USER_ID: LOCAL_USER_ID,
    },
  });
  try {
    const pong = await client.ping();
    assert.equal(pong.pong, true, 'coordinator con phải trả pong');
    await client.createBot({ bot: botConfig('bot-1', ws), provider: mockProvider('ok') });
    const res = await client.runTool('bot-1', 'manage_access', {
      action: 'add_member',
      user_id: 'via-child',
      name: 'Via Child',
      role: 'member',
    });
    assert.match(res.output, /Added member "via-child"/);
    assert.equal(loadTeamConfig(dataDir).members.find((m) => m.userId === 'via-child')?.role, 'member');
  } finally {
    await client.dispose();
  }
});
