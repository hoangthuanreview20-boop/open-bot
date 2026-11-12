/**
 * Fleet manager tests: end-to-end qua FleetManager với probe giả
 * (máy 8 core / 16GB RAM / 300GB trống) + worker thật.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fakeMachineProfile } from '../packages/core/dist/compute/probe.js';
import { FleetManager } from '../packages/core/dist/fleet/manager.js';

const GB = 1024 ** 3;

function makeManager() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-mgr-'));
  const manager = new FleetManager({
    rootDir,
    probeFn: async () => fakeMachineProfile(),
  });
  return { rootDir, manager };
}

test('manager: tạo → start → status → stop → xoá, audit + decision ghi đủ', async () => {
  const { rootDir, manager } = makeManager();
  try {
    const created = await manager.createWorkspace({ name: 'alice', osUser: 'alice' }, 'root');
    assert.equal(created.status, 'active');
    assert.equal(created.isolationLevel, 'directory');
    assert.ok(created.port >= 18000 && created.port <= 18999);
    assert.equal(fs.statSync(created.rootDir).mode & 0o777, 0o700);
    assert.equal(manager.listWorkspaces().length, 1);

    const started = await manager.startService(created.id, 'root');
    assert.equal(started.service.state, 'running');
    assert.ok(typeof started.service.pid === 'number');
    const status = manager.getStatus(created.id);
    assert.equal(status.workspace.serviceState, 'running');
    assert.ok(status.service.uptimeMs !== null && status.service.uptimeMs >= 0);
    assert.equal(status.usage, null); // chưa ghi mẫu mức dùng nào.
    const health = await manager.healthCheck(created.id);
    assert.equal(health.pid, started.service.pid);

    const recorded = manager.recordUsage(created.id);
    assert.ok(recorded !== null);
    assert.equal(recorded.workspaceId, created.id);
    assert.ok(recorded.samples >= 1);
    assert.ok(typeof recorded.diskBytesLatest === 'number' && recorded.diskBytesLatest >= 0);

    const stopped = await manager.stopService(created.id, 'root');
    assert.equal(stopped.service.state, 'stopped');
    manager.removeWorkspace(created.id, 'root');
    assert.equal(manager.listWorkspaces().length, 0);

    assert.deepEqual(manager.verifyAudit(), { ok: true, checked: 4 });
    assert.deepEqual(manager.verifyDecisions(), { ok: true, checked: 2 });
    const auditActions = manager.listAudit().map((e) => e.action);
    assert.deepEqual(auditActions, ['workspace.create', 'service.start', 'service.stop', 'workspace.remove']);
    const decisions = manager.listDecisions();
    assert.deepEqual(decisions.map((d) => d.decision), ['allow', 'allow']);
    assert.equal(decisions[0].action, 'workspace.create');
  } finally {
    await manager.dispose();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('manager: hết RAM → tạo workspace throw + ghi decision deny, không tạo gì', async () => {
  const { rootDir, manager } = makeManager();
  try {
    await assert.rejects(
      () => manager.createWorkspace({ name: 'huge', osUser: 'huge', ramBytes: 12 * GB }, 'root'),
      /Không tạo được workspace/,
    );
    assert.equal(manager.listWorkspaces().length, 0);
    assert.deepEqual(manager.verifyAudit(), { ok: true, checked: 0 });
    const decisions = manager.listDecisions();
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].decision, 'deny');
    assert.match(decisions[0].detail.reason ?? '', /MB RAM/);
    assert.equal(decisions[0].action, 'workspace.create');
  } finally {
    await manager.dispose();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('manager: xoá workspace khi service đang chạy → throw; suspend dừng service', async () => {
  const { rootDir, manager } = makeManager();
  try {
    const created = await manager.createWorkspace({ name: 'alice', osUser: 'alice' }, 'root');
    await manager.startService(created.id, 'root');
    assert.throws(() => manager.removeWorkspace(created.id, 'root'), /đang chạy/);
    const suspended = await manager.suspendWorkspace(created.id, 'root');
    assert.equal(suspended.status, 'suspended');
    assert.equal(manager.getStatus(created.id).service.state, 'stopped');
    await assert.rejects(() => manager.startService(created.id, 'root'), /đang tạm dừng/);
    const activated = manager.activateWorkspace(created.id, 'root');
    assert.equal(activated.status, 'active');
    await manager.startService(created.id, 'root');
    await manager.stopService(created.id, 'root');
    manager.removeWorkspace(created.id, 'root', { deleteData: true });
    assert.equal(fs.existsSync(created.rootDir), false);
  } finally {
    await manager.dispose();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('manager: thành viên add/remove/set-role, trùng user throw', async () => {
  const { rootDir, manager } = makeManager();
  try {
    const created = await manager.createWorkspace({ name: 'alice', osUser: 'alice' }, 'root');
    const withMember = manager.addMember(created.id, { userId: 'bob', role: 'member' }, 'root');
    assert.equal(withMember.members.length, 1);
    assert.equal(withMember.members[0].addedBy, 'root');
    assert.throws(() => manager.addMember(created.id, { userId: 'bob', role: 'member' }, 'root'), /đã là thành viên/);
    assert.throws(() => manager.addMember(created.id, { userId: 'carol', role: 'superuser' }, 'root'), /role phải là/);
    const promoted = manager.setMemberRole(created.id, 'bob', 'admin', 'root');
    assert.equal(promoted.members[0].role, 'admin');
    assert.throws(() => manager.setMemberRole(created.id, 'nobody', 'admin', 'root'), /không phải thành viên/);
    const removed = manager.removeMember(created.id, 'bob', 'root');
    assert.equal(removed.members.length, 0);
    assert.throws(() => manager.removeMember(created.id, 'bob', 'root'), /không phải thành viên/);
    assert.throws(() => manager.renameWorkspace(created.id, '   ', 'root'), /không được rỗng/);
    const renamed = manager.renameWorkspace(created.id, 'alice-2', 'root');
    assert.equal(renamed.name, 'alice-2');
  } finally {
    await manager.dispose();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('manager: đọc chéo file giữa 2 workspace bị chặn + ghi audit file.read-denied', async () => {
  const { rootDir, manager } = makeManager();
  try {
    const alice = await manager.createWorkspace({ name: 'alice', osUser: 'alice' }, 'root');
    const bob = await manager.createWorkspace({ name: 'bob', osUser: 'bob' }, 'root');
    manager.writeWorkspaceFile(alice.id, 'secret.txt', 'bí mật của alice', 'root');
    manager.writeWorkspaceFile(bob.id, 'secret.txt', 'bí mật của bob', 'root');
    assert.equal(manager.readWorkspaceFile(alice.id, 'secret.txt'), 'bí mật của alice');
    assert.throws(() => manager.readWorkspaceFile(alice.id, '../fw-bob/secret.txt'), /nằm ngoài workspace/);
    // Đọc chéo bằng đường dẫn tuyệt đối của workspace khác cũng bị chặn.
    assert.throws(() => manager.readWorkspaceFile(alice.id, bob.rootDir), /tương đối|nằm ngoài workspace/);
    const denied = manager.listAudit({ action: 'file.read-denied' });
    assert.ok(denied.length >= 2);
    assert.equal(denied[0].target, `workspace:${alice.id}`);
  } finally {
    await manager.dispose();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('manager: hai workspace chạy song song trên 2 port khác nhau', async () => {
  const { rootDir, manager } = makeManager();
  try {
    const alice = await manager.createWorkspace({ name: 'alice', osUser: 'alice' }, 'root');
    const bob = await manager.createWorkspace({ name: 'bob', osUser: 'bob' }, 'root');
    assert.notEqual(alice.port, bob.port);
    const a = await manager.startService(alice.id, 'root');
    const b = await manager.startService(bob.id, 'root');
    assert.equal(a.service.state, 'running');
    assert.equal(b.service.state, 'running');
    assert.notEqual(a.service.pid, b.service.pid);
    const fleet = manager.listFleet();
    assert.equal(fleet.length, 2);
    assert.ok(fleet.every((s) => s.service.state === 'running'));
    await manager.stopService(alice.id, 'root');
    await manager.stopService(bob.id, 'root');
  } finally {
    await manager.dispose();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('manager: manager khác process dừng được service theo pid đã lưu (stopByPid)', async () => {
  const { rootDir, manager } = makeManager();
  const managerB = new FleetManager({ rootDir, probeFn: async () => fakeMachineProfile() });
  try {
    const created = await manager.createWorkspace({ name: 'alice', osUser: 'alice' }, 'root');
    const started = await manager.startService(created.id, 'root');
    const pid = started.service.pid;
    assert.ok(typeof pid === 'number' && pid > 0);
    // Manager B không có handle của child — vẫn dừng được nhờ pid trong registry.
    const stopped = await managerB.stopService(created.id, 'root');
    assert.equal(stopped.service.state, 'stopped');
    assert.equal(managerB.getStatus(created.id).service.state, 'stopped');
    // PID thật đã chết.
    assert.throws(() => process.kill(pid, 0));
    // Restart từ manager B cũng chạy được.
    const restarted = await managerB.restartService(created.id, 'root');
    assert.equal(restarted.service.state, 'running');
    assert.notEqual(restarted.service.pid, pid);
    await managerB.stopService(created.id, 'root');
  } finally {
    await manager.dispose();
    await managerB.dispose();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('manager: getStatus khi pid đã lưu chết → báo stopped (không báo chạy ảo)', async () => {
  const { rootDir, manager } = makeManager();
  try {
    const created = await manager.createWorkspace({ name: 'alice', osUser: 'alice' }, 'root');
    await manager.startService(created.id, 'root');
    await manager.stopService(created.id, 'root');
    // Giả lập registry ghi 'running' với pid đã chết (app crash giữa chừng).
    const list = manager.listWorkspaces();
    const { saveFleetWorkspaces } = await import('../packages/core/dist/fleet/registry.js');
    saveFleetWorkspaces(
      rootDir,
      list.map((w) => (w.id === created.id ? { ...w, serviceState: 'running', pid: 999999 } : w)),
    );
    const status = manager.getStatus(created.id);
    assert.equal(status.service.state, 'stopped');
    assert.equal(status.service.pid, undefined);
  } finally {
    await manager.dispose();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
