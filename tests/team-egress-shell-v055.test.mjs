/**
 * Tests cho v0.55 — nối policy egress của team vào shell tools.
 *
 * `defaultToolFactory`/`buildToolHost` truyền resolver `getEgressPolicy`
 * xuống `shell_exec` (`createDefaultTools`) + `exec_task`/`shell_session_*`
 * (`createShellTools`); coordinator resolve policy hiệu lực = team.json
 * (dưới dataDir) merge lên trên policy chung (`resolveTeamEgressPolicy`).
 *
 * Không gọi mạng thật: lệnh chỉ `echo` URL (kích hoạt egress check mà
 * không kết nối); đích "cho phép" dùng IP literal trong allowIpRanges
 * (không cần DNS), đích "chặn" là hostname ngoài allowlist (chặn ở
 * bước khớp allowlist, cũng không cần DNS), fail-closed không cần DNS.
 * Chạy sau khi build core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/team-egress-shell-v055.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentCoordinator, BotMemory, defaultToolFactory } from '../packages/core/dist/index.js';
import { createDefaultEgressPolicy } from '../packages/core/dist/egress/index.js';
import {
  defaultTeamConfig,
  saveTeamConfig,
  setTeamEgress,
} from '../packages/core/dist/team/team.js';
import { configureSandboxEgress } from '../packages/tools/dist/sandbox.js';
import { createShellTools } from '../packages/tools/dist/shellTools.js';

const IP = '93.184.216.34';
const IP_URL = `https://${IP}/`;
const BLOCKED_URL = 'https://other.com/';

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

afterEach(() => {
  // Không để policy module của sandbox rò sang test khác.
  configureSandboxEgress(undefined);
});

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `thiếu tool ${name}`);
  return tool;
}

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

/** Policy chỉ cho đúng IP literal (không cần DNS để chứng minh "cho"). */
function allowIpPolicy() {
  return { mode: 'allowlist', allowIpRanges: [`${IP}/32`] };
}

function shellCtx(ws, botId = 'bot-1') {
  return { workspaceDir: ws, botId };
}

// ---------------------------------------------------------------------------
// Factory: shell_exec tự resolve team policy qua host.getEgressPolicy
// ---------------------------------------------------------------------------

test('team-egress: shell_exec qua defaultToolFactory — team cho IP, chặn host ngoài list', async () => {
  const ws = tmpDir('open-bot-egress-factory-');
  const mem = new BotMemory(ws);
  try {
    const tools = defaultToolFactory(mem, ws, 'bot-1', undefined, {
      getEgressPolicy: () => allowIpPolicy(),
    });
    const shellExec = toolByName(tools, 'shell_exec');
    const ok = await shellExec.execute({ command: `echo ${IP_URL}` }, shellCtx(ws));
    assert.match(ok, /exit code: 0/, 'IP trong allowIpRanges của team phải chạy được');
    assert.ok(ok.includes(IP), 'stdout phải chứa URL đã echo');
    const blocked = await shellExec.execute({ command: `echo ${BLOCKED_URL}` }, shellCtx(ws));
    assert.match(blocked, /^Error:/, 'host ngoài allowlist phải trả lỗi thay vì chạy');
    assert.match(blocked, /egress_not_allowlisted/, 'lỗi phải mang mã egress_not_allowlisted');
  } finally {
    mem.close();
  }
});

test('team-egress: resolver trả undefined thì fail-closed dù policy module đang nới hơn', async () => {
  // Policy module cho IP — nếu shell còn rơi về module thì lệnh sẽ chạy.
  configureSandboxEgress(allowIpPolicy());
  const ws = tmpDir('open-bot-egress-factory-');
  const mem = new BotMemory(ws);
  try {
    const tools = defaultToolFactory(mem, ws, 'bot-1', undefined, {
      getEgressPolicy: () => undefined,
    });
    const out = await toolByName(tools, 'shell_exec').execute(
      { command: `echo ${IP_URL}` },
      shellCtx(ws),
    );
    assert.match(out, /^Error:/);
    assert.match(out, /egress_unconfigured/, 'resolver "không có policy" phải thắng policy module');
  } finally {
    mem.close();
  }
});

test('team-egress: resolver trả null thì tắt hẳn (giữ hành vi opts.egressPolicy null)', async () => {
  const ws = tmpDir('open-bot-egress-factory-');
  const mem = new BotMemory(ws);
  try {
    const tools = defaultToolFactory(mem, ws, 'bot-1', undefined, {
      getEgressPolicy: () => null,
    });
    const out = await toolByName(tools, 'shell_exec').execute(
      { command: `echo ${BLOCKED_URL}` },
      shellCtx(ws),
    );
    assert.match(out, /exit code: 0/, 'null = tắt kiểm tra, lệnh chạy như cũ');
  } finally {
    mem.close();
  }
});

test('team-egress: không có host resolver thì shell_exec giữ hành vi cũ (policy module)', async () => {
  configureSandboxEgress(allowIpPolicy());
  const ws = tmpDir('open-bot-egress-factory-');
  const mem = new BotMemory(ws);
  try {
    const tools = defaultToolFactory(mem, ws, 'bot-1');
    const ok = await toolByName(tools, 'shell_exec').execute(
      { command: `echo ${IP_URL}` },
      shellCtx(ws),
    );
    assert.match(ok, /exit code: 0/, 'không có resolver thì policy module vẫn áp như trước');
  } finally {
    mem.close();
  }
});

// ---------------------------------------------------------------------------
// exec_task (createShellTools, đường in-process) cũng resolve team policy
// ---------------------------------------------------------------------------

async function pollTaskStatus(tools, ctx, taskId) {
  const statusTool = toolByName(tools, 'exec_task_status');
  let status;
  for (let i = 0; i < 50; i++) {
    status = JSON.parse(await statusTool.execute({ taskId }, ctx));
    if (status.status !== 'running') return status;
    await new Promise((r) => setTimeout(r, 100));
  }
  return status;
}

test('team-egress: exec_task đường in-process — team cho IP, chặn host ngoài list', async () => {
  const ws = tmpDir('open-bot-egress-task-');
  const tools = createShellTools({ getEgressPolicy: () => allowIpPolicy() });
  const ctx = shellCtx(ws);
  const started = JSON.parse(
    await toolByName(tools, 'exec_task').execute({ command: `echo ${IP_URL}` }, ctx),
  );
  const done = await pollTaskStatus(tools, ctx, started.taskId);
  assert.equal(done.status, 'done');
  assert.ok(done.stdout.includes(IP));
  const startedBlocked = JSON.parse(
    await toolByName(tools, 'exec_task').execute({ command: `echo ${BLOCKED_URL}` }, ctx),
  );
  const failed = await pollTaskStatus(tools, ctx, startedBlocked.taskId);
  assert.equal(failed.status, 'failed');
  assert.match(failed.stderr, /egress_not_allowlisted/);
});

// ---------------------------------------------------------------------------
// Coordinator: team.json (dataDir) merge lên trên policy chung
// ---------------------------------------------------------------------------

async function makeCoordinator({ teamEgress, globalPolicy }) {
  const dataDir = tmpDir('open-bot-egress-coord-');
  const ws = tmpDir('open-bot-egress-ws-');
  if (teamEgress !== undefined) {
    saveTeamConfig(dataDir, setTeamEgress(defaultTeamConfig(), teamEgress));
  } else {
    // team.json có sẵn nhưng không đặt egress (fallback phải về global).
    saveTeamConfig(dataDir, defaultTeamConfig());
  }
  const coord = new AgentCoordinator({
    dataDir,
    ...(globalPolicy !== undefined ? { egressPolicy: globalPolicy } : {}),
  });
  await coord.createBot({ bot: botConfig('bot-1', ws), provider: mockProvider('ok') });
  return { coord, ws };
}

async function runShellExec(coord, ws, command) {
  const res = await coord.runTool({ botId: 'bot-1', tool: 'shell_exec', args: { command } });
  return res.output;
}

test('team-egress: team đặt thắng policy chung (global chặn hết, team cho IP)', async () => {
  const { coord, ws } = await makeCoordinator({
    teamEgress: { allowIpRanges: [`${IP}/32`] },
    globalPolicy: createDefaultEgressPolicy(),
  });
  try {
    const ok = await runShellExec(coord, ws, `echo ${IP_URL}`);
    assert.match(ok, /exit code: 0/, 'field team đặt phải thắng policy chung');
    const blocked = await runShellExec(coord, ws, `echo ${BLOCKED_URL}`);
    assert.match(blocked, /egress_not_allowlisted/);
  } finally {
    coord.shutdown();
  }
});

test('team-egress: team không đặt thì fallback về policy chung', async () => {
  const { coord, ws } = await makeCoordinator({
    teamEgress: undefined,
    globalPolicy: allowIpPolicy(),
  });
  try {
    const ok = await runShellExec(coord, ws, `echo ${IP_URL}`);
    assert.match(ok, /exit code: 0/, 'team không đặt egress thì policy chung phải áp');
    const blocked = await runShellExec(coord, ws, `echo ${BLOCKED_URL}`);
    assert.match(blocked, /egress_not_allowlisted/);
  } finally {
    coord.shutdown();
  }
});

test('team-egress: cả team lẫn policy chung đều không có thì fail-closed', async () => {
  const { coord, ws } = await makeCoordinator({ teamEgress: undefined });
  try {
    const out = await runShellExec(coord, ws, `echo ${IP_URL}`);
    assert.match(out, /^Error:/);
    assert.match(out, /egress_unconfigured/);
    // Lệnh không có đích mạng vẫn chạy như cũ (fail-closed chỉ chặn mạng).
    const plain = await runShellExec(coord, ws, 'echo hello');
    assert.match(plain, /exit code: 0/);
    assert.ok(plain.includes('hello'));
  } finally {
    coord.shutdown();
  }
});

test('team-egress: đổi policy lúc chạy có hiệu lực ngay, không cần tạo lại bot', async () => {
  const { coord, ws } = await makeCoordinator({ teamEgress: undefined });
  try {
    const before = await runShellExec(coord, ws, `echo ${IP_URL}`);
    assert.match(before, /egress_unconfigured/);
    // (a) Đặt policy chung lúc chạy.
    coord.setEgressPolicy(allowIpPolicy());
    const afterGlobal = await runShellExec(coord, ws, `echo ${IP_URL}`);
    assert.match(afterGlobal, /exit code: 0/, 'setEgressPolicy phải có hiệu lực ngay');
    // (b) Gỡ policy chung thì lại fail-closed.
    coord.setEgressPolicy(undefined);
    const afterClear = await runShellExec(coord, ws, `echo ${IP_URL}`);
    assert.match(afterClear, /egress_unconfigured/, 'gỡ policy chung thì lại fail-closed');
  } finally {
    coord.shutdown();
  }
});

test('team-egress: sửa team.json lúc chạy có hiệu lực ngay (team thắng global)', async () => {
  const dataDir = tmpDir('open-bot-egress-coord-');
  const ws = tmpDir('open-bot-egress-ws-');
  saveTeamConfig(dataDir, defaultTeamConfig());
  const coord = new AgentCoordinator({ dataDir, egressPolicy: createDefaultEgressPolicy() });
  try {
    await coord.createBot({ bot: botConfig('bot-1', ws), provider: mockProvider('ok') });
    const before = await runShellExec(coord, ws, `echo ${IP_URL}`);
    assert.match(before, /egress_not_allowlisted/, 'chưa có team egress thì global (chặn hết) áp');
    saveTeamConfig(dataDir, setTeamEgress(defaultTeamConfig(), { allowIpRanges: [`${IP}/32`] }));
    const after = await runShellExec(coord, ws, `echo ${IP_URL}`);
    assert.match(after, /exit code: 0/, 'ghi team egress mới phải có hiệu lực ngay');
  } finally {
    coord.shutdown();
  }
});
