/**
 * Tests for the fleet console v2 (packages/core/src/fleet/console.ts).
 *
 * Covers the role permission matrix, the fleet-wide user directory
 * (add / role change / remove / workspace assignment, including the
 * last-admin guard), the hash-chained audit trail for console actions,
 * and the per-bot overview projection.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/fleet-console-v102.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  FLEET_CONSOLE_ACTIONS,
  FLEET_CONSOLE_ROLES,
  FleetConsole,
  assertCanPerform,
  buildFleetBotOverview,
  canPerform,
  listFleetAuditEvents,
  loadFleetConsoleUsers,
} from '../packages/core/dist/fleet/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-fleet-console-'));
}

function makeStatus(overrides = {}) {
  return {
    workspace: {
      id: 'fw-1',
      name: 'Alice bot',
      osUser: 'alice',
      serviceName: 'open-bot-alice',
      port: 18001,
      rootDir: '/tmp/fleet/fw-1',
      cpuCores: 2,
      ramBytes: 2 * 1024 ** 3,
      diskBytes: 10 * 1024 ** 3,
      members: [{ userId: 'alice', role: 'admin', addedBy: 'system', addedAt: '2026-01-01T00:00:00.000Z' }],
      status: 'active',
      serviceState: 'running',
      isolationLevel: 'directory',
      createdBy: 'system',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...(overrides.workspace ?? {}),
    },
    service: {
      state: 'running',
      pid: 1234,
      uptimeMs: 60000,
      lastHealthAt: Date.now(),
      ...(overrides.service ?? {}),
    },
    usage:
      overrides.usage !== undefined
        ? overrides.usage
        : {
            workspaceId: 'fw-1',
            samples: 3,
            windowStart: 1000,
            windowEnd: 4000,
            cpuSecondsMax: 42,
            rssBytesLatest: 1024 ** 3,
            diskBytesLatest: 2 * 1024 ** 3,
          },
  };
}

// --- permission matrix -----------------------------------------------------

test('console roles: admin can do everything, viewer almost nothing', () => {
  assert.deepEqual([...FLEET_CONSOLE_ROLES], ['admin', 'operator', 'viewer']);
  for (const action of FLEET_CONSOLE_ACTIONS) {
    assert.equal(canPerform('admin', action), true, `admin should do ${action}`);
  }
  assert.equal(canPerform('operator', 'manageUsers'), false);
  assert.equal(canPerform('operator', 'manageWorkspaces'), false);
  assert.equal(canPerform('operator', 'manageBots'), true);
  assert.equal(canPerform('operator', 'installPlugins'), true);
  assert.equal(canPerform('operator', 'changeQuotas'), true);
  assert.equal(canPerform('operator', 'startStopServices'), true);
  assert.equal(canPerform('operator', 'viewUsage'), true);
  assert.equal(canPerform('viewer', 'manageBots'), false);
  assert.equal(canPerform('viewer', 'changeQuotas'), false);
  assert.equal(canPerform('viewer', 'viewUsage'), true);
  assert.equal(canPerform('viewer', 'viewAudit'), true);
  assert.equal(canPerform('viewer', 'rateMarketplace'), true);
  assert.throws(() => assertCanPerform('viewer', 'manageUsers'), /may not perform/);
  assert.doesNotThrow(() => assertCanPerform('operator', 'startStopServices'));
});

// --- user directory --------------------------------------------------------

test('console: add/list/get users, sorted by userId', () => {
  const dir = tmpDir();
  const fleetConsole = new FleetConsole(dir);
  assert.deepEqual(fleetConsole.listUsers(), []);
  const bob = fleetConsole.addUser({ userId: 'bob', role: 'operator' }, 'admin-1');
  assert.equal(bob.userId, 'bob');
  assert.equal(bob.displayName, 'bob');
  assert.equal(bob.role, 'operator');
  assert.deepEqual(bob.workspaceIds, []);
  fleetConsole.addUser({ userId: 'alice', displayName: 'Alice', role: 'admin' }, 'admin-1');
  assert.deepEqual(
    fleetConsole.listUsers().map((u) => u.userId),
    ['alice', 'bob'],
  );
  assert.equal(fleetConsole.getUser('alice')?.displayName, 'Alice');
  assert.equal(fleetConsole.getUser('nobody'), undefined);
  // Stored on disk, mode 0600, reloadable.
  assert.equal(loadFleetConsoleUsers(dir).length, 2);
  assert.equal((fs.statSync(path.join(dir, 'fleet-users.json')).mode & 0o777), 0o600);
});

test('console: duplicate userId and bad role throw', () => {
  const dir = tmpDir();
  const fleetConsole = new FleetConsole(dir);
  fleetConsole.addUser({ userId: 'bob', role: 'viewer' }, 'admin-1');
  assert.throws(() => fleetConsole.addUser({ userId: 'bob', role: 'viewer' }, 'admin-1'), /already exists/);
  assert.throws(
    () => fleetConsole.addUser({ userId: 'carol', role: 'superuser' }, 'admin-1'),
    /must be one of/,
  );
  assert.throws(() => fleetConsole.addUser({ userId: '  ', role: 'viewer' }, 'admin-1'), /non-empty userId/);
  assert.throws(() => fleetConsole.addUser({ userId: 'dave', role: 'viewer' }, '  '), /non-empty actor/);
});

test('console: last admin cannot be demoted or removed', () => {
  const dir = tmpDir();
  const fleetConsole = new FleetConsole(dir);
  fleetConsole.addUser({ userId: 'alice', role: 'admin' }, 'system');
  assert.throws(() => fleetConsole.setRole('alice', 'viewer', 'system'), /last admin/);
  assert.throws(() => fleetConsole.removeUser('alice', 'system'), /last admin/);
  // A second admin lifts the guard.
  fleetConsole.addUser({ userId: 'bob', role: 'admin' }, 'system');
  assert.equal(fleetConsole.setRole('alice', 'operator', 'bob').role, 'operator');
  assert.equal(fleetConsole.removeUser('alice', 'bob'), true);
  assert.equal(fleetConsole.removeUser('alice', 'bob'), false);
  assert.throws(() => fleetConsole.setRole('ghost', 'viewer', 'bob'), /not found/);
});

test('console: workspace assign/unassign is idempotent and audited', () => {
  const dir = tmpDir();
  const fleetConsole = new FleetConsole(dir);
  fleetConsole.addUser({ userId: 'alice', role: 'admin' }, 'system');
  const assigned = fleetConsole.assignWorkspace('alice', 'fw-1', 'system');
  assert.deepEqual(assigned.workspaceIds, ['fw-1']);
  assert.deepEqual(fleetConsole.assignWorkspace('alice', 'fw-1', 'system').workspaceIds, ['fw-1']);
  const unassigned = fleetConsole.unassignWorkspace('alice', 'fw-1', 'system');
  assert.deepEqual(unassigned.workspaceIds, []);
  assert.throws(() => fleetConsole.assignWorkspace('ghost', 'fw-1', 'system'), /not found/);
  const actions = listFleetAuditEvents(dir).map((e) => e.action);
  assert.ok(actions.includes('console.user-add'));
  assert.ok(actions.includes('console.workspace-assign'));
  assert.ok(actions.includes('console.workspace-unassign'));
});

test('console: role changes append audit events with from/to detail', () => {
  const dir = tmpDir();
  const fleetConsole = new FleetConsole(dir);
  fleetConsole.addUser({ userId: 'alice', role: 'admin' }, 'system');
  fleetConsole.addUser({ userId: 'bob', role: 'viewer' }, 'alice');
  fleetConsole.setRole('bob', 'operator', 'alice');
  const events = listFleetAuditEvents(dir).filter((e) => e.action === 'console.role-change');
  assert.equal(events.length, 1);
  assert.equal(events[0].actor, 'alice');
  assert.equal(events[0].target, 'user:bob');
  assert.deepEqual(events[0].detail, { from: 'viewer', to: 'operator' });
});

// --- bot overview ----------------------------------------------------------

test('overview: projects status into rows with used/allocated percents', () => {
  const rows = buildFleetBotOverview([makeStatus()]);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.workspaceId, 'fw-1');
  assert.equal(row.name, 'Alice bot');
  assert.equal(row.state, 'running');
  assert.equal(row.pid, 1234);
  assert.equal(row.uptimeMs, 60000);
  assert.equal(row.ramUsedBytes, 1024 ** 3);
  assert.equal(row.ramUsedPercent, 0.5);
  assert.equal(row.diskUsedPercent, 0.2);
  assert.equal(row.cpuSecondsTotal, 42);
  assert.deepEqual(row.members, [{ userId: 'alice', role: 'admin' }]);
});

test('overview: unmeasured usage is null, never faked to zero', () => {
  const rows = buildFleetBotOverview([
    makeStatus({ service: { state: 'stopped', pid: undefined, uptimeMs: null }, usage: null }),
  ]);
  const row = rows[0];
  assert.equal(row.state, 'stopped');
  assert.equal(row.pid, undefined);
  assert.equal(row.ramUsedBytes, null);
  assert.equal(row.ramUsedPercent, null);
  assert.equal(row.diskUsedPercent, null);
  assert.equal(row.cpuSecondsTotal, null);
});
