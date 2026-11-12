/**
 * Fleet isolation tests: đọc/ghi chéo workspace phải fail-closed,
 * symlink thoát ra ngoài bị chặn, vault tách theo workspace.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  assertWorkspaceRootInsideFleet,
  currentOsUser,
  fleetVaultKey,
  fleetVaultNamespace,
  getOsUserUid,
  isRunningPrivileged,
  probeOsUser,
  readWorkspaceFile,
  resolveFleetWorkspacePath,
  resolveIsolationLevel,
  writeWorkspaceFile,
} from '../packages/core/dist/fleet/isolation.js';

function ws(rootDir, overrides = {}) {
  return {
    id: 'fw-alice',
    name: 'alice',
    osUser: 'alice',
    serviceName: 'open-bot-alice',
    port: 18001,
    rootDir,
    cpuCores: 1,
    ramBytes: 512 * 1024 ** 2,
    diskBytes: 10 * 1024 ** 3,
    members: [],
    status: 'active',
    serviceState: 'stopped',
    isolationLevel: 'directory',
    createdBy: 'root',
    createdAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:00:00.000Z',
    ...overrides,
  };
}

function setup() {
  const fleetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-iso-'));
  const rootA = path.join(fleetRoot, 'workspaces', 'fw-a');
  const rootB = path.join(fleetRoot, 'workspaces', 'fw-b');
  fs.mkdirSync(rootA, { recursive: true });
  fs.mkdirSync(rootB, { recursive: true });
  fs.writeFileSync(path.join(rootA, 'secret.txt'), 'bí mật của alice', 'utf8');
  fs.writeFileSync(path.join(rootB, 'secret.txt'), 'bí mật của bob', 'utf8');
  return { fleetRoot, rootA, rootB };
}

test('isolation: đọc/ghi đúng workspace được, đọc chéo bằng ../ bị chặn', () => {
  const { fleetRoot, rootA } = setup();
  const alice = ws(rootA);
  assert.equal(readWorkspaceFile(alice, 'secret.txt'), 'bí mật của alice');
  writeWorkspaceFile(alice, 'notes/hello.txt', 'xin chào');
  assert.equal(readWorkspaceFile(alice, 'notes/hello.txt'), 'xin chào');
  assert.throws(() => readWorkspaceFile(alice, '../fw-b/secret.txt'), /nằm ngoài workspace/);
  assert.throws(() => writeWorkspaceFile(alice, '../fw-b/evil.txt', 'x'), /nằm ngoài workspace/);
  assert.throws(() => readWorkspaceFile(alice, '/etc/passwd'), /tương đối|nằm ngoài workspace/);
  assert.throws(() => readWorkspaceFile(alice, 'nope.txt'), /ENOENT/);
  assert.doesNotThrow(() => assertWorkspaceRootInsideFleet(fleetRoot, rootA));
  assert.throws(() => assertWorkspaceRootInsideFleet(fleetRoot, '/etc'), /phải nằm trong thư mục gốc của fleet/);
});

test('isolation: symlink trong workspace trỏ ra ngoài bị chặn', () => {
  if (process.platform === 'win32') return; // symlink trên Windows cần quyền đặc biệt.
  const { rootA, rootB } = setup();
  fs.symlinkSync(path.join(rootB, 'secret.txt'), path.join(rootA, 'link-to-bob.txt'));
  const alice = ws(rootA);
  assert.throws(() => readWorkspaceFile(alice, 'link-to-bob.txt'), /nằm ngoài workspace/);
  fs.symlinkSync(rootB, path.join(rootA, 'link-to-bob-dir'));
  assert.throws(() => readWorkspaceFile(alice, 'link-to-bob-dir/secret.txt'), /nằm ngoài workspace/);
  // Symlink nội bộ trong cùng workspace vẫn được.
  fs.writeFileSync(path.join(rootA, 'inner.txt'), 'trong nhà', 'utf8');
  fs.symlinkSync(path.join(rootA, 'inner.txt'), path.join(rootA, 'link-inner.txt'));
  assert.equal(readWorkspaceFile(alice, 'link-inner.txt'), 'trong nhà');
});

test('isolation: vault tách namespace theo workspace', () => {
  assert.equal(fleetVaultNamespace('fw-alice'), 'fleet:fw-alice');
  assert.notEqual(fleetVaultNamespace('fw-alice'), fleetVaultNamespace('fw-bob'));
  assert.equal(fleetVaultKey('fw-alice', 'openai.apiKey'), 'fleet:fw-alice:openai.apiKey');
  assert.notEqual(fleetVaultKey('fw-alice', 'openai.apiKey'), fleetVaultKey('fw-bob', 'openai.apiKey'));
});

test('isolation: resolveIsolationLevel — os-user chỉ khi đủ 3 điều kiện', () => {
  const osUser = resolveIsolationLevel({ runningAsRoot: true, osUserExists: true, platform: 'linux' });
  assert.equal(osUser.level, 'os-user');
  assert.equal(osUser.reason, undefined);
  assert.equal(resolveIsolationLevel({ runningAsRoot: false, osUserExists: true, platform: 'linux' }).level, 'directory');
  assert.match(resolveIsolationLevel({ runningAsRoot: false, osUserExists: true, platform: 'linux' }).reason ?? '', /chưa chạy đặc quyền/);
  assert.equal(resolveIsolationLevel({ runningAsRoot: true, osUserExists: false, platform: 'linux' }).level, 'directory');
  assert.match(resolveIsolationLevel({ runningAsRoot: true, osUserExists: false, platform: 'linux' }).reason ?? '', /OS user chưa tồn tại/);
  assert.equal(resolveIsolationLevel({ runningAsRoot: true, osUserExists: true, platform: 'win32' }).level, 'directory');
  assert.match(resolveIsolationLevel({ runningAsRoot: true, osUserExists: true, platform: 'win32' }).reason ?? '', /Windows/);
});

test('isolation: resolveFleetWorkspacePath chuẩn hoá đường dẫn, chặn ../', () => {
  const { rootA } = setup();
  const alice = ws(rootA);
  assert.equal(resolveFleetWorkspacePath(alice, 'a/../b.txt'), path.join(rootA, 'b.txt'));
  assert.equal(resolveFleetWorkspacePath(alice, './x.txt'), path.join(rootA, 'x.txt'));
  assert.throws(() => resolveFleetWorkspacePath(alice, '../../etc/passwd'), /nằm ngoài workspace/);
  assert.throws(() => resolveFleetWorkspacePath(alice, ''), /không được rỗng/);
});

test('isolation: probeOsUser/isRunningPrivileged/getOsUserUid phản ánh hệ thống thật', () => {
  const current = currentOsUser();
  assert.ok(typeof current === 'string' && current.length > 0);
  const probe = probeOsUser(current);
  assert.equal(probe.exists, true);
  const uid = getOsUserUid(current);
  assert.ok(uid !== null && uid >= 0);
  assert.equal(probeOsUser('chắc-chắn-không-có-user-này-xyz').exists, false);
  assert.equal(isRunningPrivileged(), process.geteuid?.() === 0);
  assert.equal(getOsUserUid(current), uid);
  assert.equal(getOsUserUid('chắc-chắn-không-có-user-này-xyz'), null);
});
