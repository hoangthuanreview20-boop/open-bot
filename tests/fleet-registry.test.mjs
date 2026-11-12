/**
 * Fleet registry tests: CRUD + validation + tính duy nhất.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createFleetWorkspace,
  findFleetWorkspace,
  loadFleetWorkspaces,
  pickFreePort,
  removeFleetWorkspace,
  renameFleetWorkspace,
  saveFleetWorkspaces,
  setFleetWorkspaceStatus,
  updateFleetWorkspace,
  validateFleetWorkspace,
  validateFleetWorkspaces,
} from '../packages/core/dist/fleet/registry.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-registry-'));
}

function makeInput(overrides = {}) {
  return {
    name: 'alice',
    osUser: 'alice',
    rootDir: path.join(os.tmpdir(), `fleet-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    ...overrides,
  };
}

test('registry: tạo workspace mới có mặc định hợp lý', () => {
  const { workspace } = createFleetWorkspace([], makeInput());
  assert.match(workspace.id, /^fw-/);
  assert.equal(workspace.name, 'alice');
  assert.equal(workspace.osUser, 'alice');
  assert.equal(workspace.serviceName, 'open-bot-alice');
  assert.ok(workspace.port >= 18000 && workspace.port <= 18999);
  assert.equal(workspace.cpuCores, 1);
  assert.equal(workspace.ramBytes, 512 * 1024 ** 2);
  assert.equal(workspace.diskBytes, 10 * 1024 ** 3);
  assert.equal(workspace.status, 'active');
  assert.equal(workspace.serviceState, 'stopped');
  assert.equal(workspace.isolationLevel, 'directory');
  assert.deepEqual(workspace.members, []);
});

test('registry: trùng tên/osUser/serviceName/port/rootDir đều throw', () => {
  const { list } = createFleetWorkspace([], makeInput());
  const base = makeInput();
  assert.throws(() => createFleetWorkspace(list, { ...base, osUser: 'bob', rootDir: '/tmp/fleet-ws-bob' }), /Đã có workspace tên/);
  assert.throws(() => createFleetWorkspace(list, { ...base, name: 'bob', rootDir: '/tmp/fleet-ws-bob' }), /OS user "alice" đã dùng/);
  assert.throws(
    () => createFleetWorkspace(list, { ...base, name: 'bob', osUser: 'bob', serviceName: 'open-bot-alice', rootDir: '/tmp/fleet-ws-bob' }),
    /Đã có service tên/,
  );
  const first = list[0];
  assert.throws(
    () => createFleetWorkspace(list, { ...base, name: 'bob', osUser: 'bob', port: first.port, rootDir: '/tmp/fleet-ws-bob' }),
    /Port .* đã dùng/,
  );
  assert.throws(
    () => createFleetWorkspace(list, { ...base, name: 'bob', osUser: 'bob', rootDir: first.rootDir }),
    /Thư mục .* đã dùng/,
  );
});

test('registry: validate osUser/port/cpu/ram/disk', () => {
  assert.throws(() => createFleetWorkspace([], makeInput({ osUser: 'Alice' })), /osUser không hợp lệ/);
  assert.throws(() => createFleetWorkspace([], makeInput({ osUser: 'a b' })), /osUser không hợp lệ/);
  assert.throws(() => createFleetWorkspace([], makeInput({ port: 80 })), /port phải là số nguyên/);
  assert.throws(() => createFleetWorkspace([], makeInput({ port: 70000 })), /port phải là số nguyên/);
  assert.throws(() => createFleetWorkspace([], makeInput({ cpuCores: 0.1 })), /cpuCores phải/);
  assert.throws(() => createFleetWorkspace([], makeInput({ ramBytes: 1024 })), /ramBytes phải/);
  assert.throws(() => createFleetWorkspace([], makeInput({ diskBytes: 1024 })), /diskBytes phải/);
  assert.throws(() => createFleetWorkspace([], makeInput({ rootDir: 'relative/path' })), /rootDir/);
});

test('registry: pickFreePort bỏ qua port đã dùng, hết dải thì throw', () => {
  const { list } = createFleetWorkspace([], makeInput());
  const picked = pickFreePort(list);
  assert.notEqual(picked, list[0].port);
  assert.ok(picked >= 18000 && picked <= 18999);
  const full = Array.from({ length: 1000 }, (_, i) => ({
    ...list[0],
    id: `fw-${i}`,
    name: `ws-${i}`,
    osUser: `u${i}`,
    serviceName: `svc-${i}`,
    port: 18000 + i,
    rootDir: `/tmp/fleet-ws-${i}`,
  }));
  assert.throws(() => pickFreePort(full), /Hết port trống/);
});

test('registry: lưu/tải round-trip, file 0600, JSON hỏng throw', () => {
  const dir = tmpDir();
  const { list, workspace } = createFleetWorkspace([], makeInput());
  saveFleetWorkspaces(dir, list);
  const loaded = loadFleetWorkspaces(dir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, workspace.id);
  const stat = fs.statSync(path.join(dir, 'fleet.json'));
  assert.equal(stat.mode & 0o777, 0o600);
  fs.writeFileSync(path.join(dir, 'fleet.json'), '{ hỏng', 'utf8');
  assert.throws(() => loadFleetWorkspaces(dir), /không phải JSON hợp lệ/);
  assert.deepEqual(loadFleetWorkspaces(tmpDir()), []);
});

test('registry: rename/remove/update/status + validate trùng lặp', () => {
  const { list } = createFleetWorkspace([], makeInput());
  const { list: list2 } = createFleetWorkspace(list, makeInput({ name: 'bob', osUser: 'bob', rootDir: '/tmp/fleet-ws-bob' }));
  const renamed = renameFleetWorkspace(list2, list2[0].id, 'alice-2');
  assert.equal(findFleetWorkspace(renamed, list2[0].id)?.name, 'alice-2');
  assert.throws(() => renameFleetWorkspace(list2, list2[0].id, 'bob'), /Đã có workspace tên/);
  assert.throws(() => renameFleetWorkspace(list2, list2[0].id, '  '), /không được rỗng/);
  const suspended = setFleetWorkspaceStatus(list2, list2[0].id, 'suspended');
  assert.equal(findFleetWorkspace(suspended, list2[0].id)?.status, 'suspended');
  const updated = updateFleetWorkspace(list2, list2[0].id, { serviceState: 'running', pid: 1234 });
  assert.equal(findFleetWorkspace(updated, list2[0].id)?.serviceState, 'running');
  assert.equal(findFleetWorkspace(updated, list2[0].id)?.pid, 1234);
  assert.throws(() => updateFleetWorkspace(list2, list2[0].id, { serviceState: 'bogus' }), /serviceState phải là/);
  const removed = removeFleetWorkspace(list2, list2[0].id);
  assert.equal(removed.length, 1);
  assert.throws(() => removeFleetWorkspace(list2, 'no-such-id'), /Không có workspace fleet/);
  assert.throws(() => validateFleetWorkspace({ ...list2[0], port: 80 }), /port là số nguyên/);
  assert.throws(() => validateFleetWorkspaces([{ ...list2[0] }, { ...list2[1], port: list2[0].port }]), /trùng port/);
});
