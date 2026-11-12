/**
 * Tests for v0.5 worker 3: team workspace + service accounts, Vault
 * NO_STORAGE mode, machine id + secret redaction (packages/core/src).
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/team-v05.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createServiceAccount,
  defaultTeamConfig,
  ensureTeamId,
  getTeamId,
  listServiceAccounts,
  loadTeamConfig,
  revokeServiceAccount,
  saveTeamConfig,
  serviceAccountVaultKey,
  setWorkspaceDir,
  validateTeamConfig,
} from '../packages/core/dist/team/team.js';
import { Vault } from '../packages/core/dist/vault/index.js';
import { getOrCreateMachineId, redactBearer, redactSecrets } from '../packages/core/dist/util/index.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-team-v05-test-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A pre-v0.5 team.json: no teamId, no workspaceDir, no serviceAccounts. */
function writeLegacyTeam(dir) {
  const legacy = {
    id: 'default',
    name: 'Default team',
    members: [{ userId: 'huy', name: 'Huy', role: 'admin' }],
    sharedBots: [],
  };
  fs.writeFileSync(path.join(dir, 'team.json'), JSON.stringify(legacy, null, 2), 'utf8');
  return legacy;
}

// ---------------------------------------------------------------------------
// teamId: stable across loads, generated for legacy files
// ---------------------------------------------------------------------------

test('teamId is stable across two loads; a legacy file gains one on first load', () => {
  const dir = makeTempDir();
  writeLegacyTeam(dir);

  const first = loadTeamConfig(dir);
  assert.match(first.teamId, UUID_RE);
  assert.deepEqual(first.serviceAccounts, []);
  assert.equal(first.workspaceDir, undefined);

  const second = loadTeamConfig(dir);
  assert.equal(second.teamId, first.teamId, 'teamId must not change between loads');

  // The generated id was written back to team.json.
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'team.json'), 'utf8'));
  assert.equal(onDisk.teamId, first.teamId);

  // Old-shape input validates with fresh defaults.
  const validated = validateTeamConfig({ id: 't1', name: 'T', members: [], sharedBots: [] });
  assert.match(validated.teamId, UUID_RE);
  assert.deepEqual(validated.serviceAccounts, []);
});

test('ensureTeamId / getTeamId agree and never mutate the input', () => {
  const team = defaultTeamConfig();
  assert.match(team.teamId, UUID_RE);
  const ensured = ensureTeamId(team);
  assert.equal(ensured.teamId, team.teamId);
  assert.equal(getTeamId(team), team.teamId);

  // A hand-built config without teamId gets one from ensureTeamId,
  // but the original object is untouched.
  const bare = { id: 't1', name: 'T', members: [], sharedBots: [] };
  const withId = ensureTeamId(bare);
  assert.match(withId.teamId, UUID_RE);
  assert.equal(bare.teamId, undefined);
  assert.equal(getTeamId(withId), withId.teamId);
});

// ---------------------------------------------------------------------------
// workspace dir: set / get / clear
// ---------------------------------------------------------------------------

test('setWorkspaceDir sets, trims and clears the team workspace dir', () => {
  const team = defaultTeamConfig();
  assert.equal(team.workspaceDir, undefined);

  const set = setWorkspaceDir(team, '  /shared/team-ws  ');
  assert.equal(set.workspaceDir, '/shared/team-ws');
  assert.equal(team.workspaceDir, undefined, 'input must not be mutated');

  const cleared = setWorkspaceDir(set, '   ');
  assert.equal(cleared.workspaceDir, undefined);

  // Persists through save/load.
  const dir = makeTempDir();
  saveTeamConfig(dir, set);
  assert.equal(loadTeamConfig(dir).workspaceDir, '/shared/team-ws');
  assert.throws(() => setWorkspaceDir(team, 42), /must be a string/);
});

// ---------------------------------------------------------------------------
// service accounts: create / list / revoke, no token in the record
// ---------------------------------------------------------------------------

test('service account create/list/revoke works; record holds no token', () => {
  const team = defaultTeamConfig();
  assert.deepEqual(listServiceAccounts(team), []);

  const { team: withOne, account } = createServiceAccount(team, { name: 'CI nightly', scope: 'run' });
  assert.match(account.id, /^sa-[0-9a-f-]{36}$/i);
  assert.equal(account.name, 'CI nightly');
  assert.equal(account.scope, 'run');
  assert.equal(typeof account.createdAt, 'number');
  assert.ok(account.createdAt > 0);
  assert.equal('token' in account, false, 'the record must never carry a token');
  assert.deepEqual(listServiceAccounts(team), [], 'input team must not be mutated');
  assert.equal(listServiceAccounts(withOne).length, 1);

  // Vault address of the token (namespace 'service-account', key = id).
  assert.equal(serviceAccountVaultKey(account.id), `service-account:${account.id}`);

  // Second account, admin scope; ids differ.
  const second = createServiceAccount(withOne, { name: '  deploy-bot ', scope: 'admin' });
  assert.equal(second.account.scope, 'admin');
  assert.equal(second.account.name, 'deploy-bot', 'name is trimmed');
  assert.notEqual(second.account.id, account.id);
  assert.equal(listServiceAccounts(second.team).length, 2);

  // Revoke is idempotent: first call removes, second reports false.
  const revoked = revokeServiceAccount(second.team, account.id);
  assert.equal(revoked.removed, true);
  assert.equal(listServiceAccounts(revoked.team).length, 1);
  const again = revokeServiceAccount(revoked.team, account.id);
  assert.equal(again.removed, false);
  assert.equal(listServiceAccounts(again.team).length, 1);

  // Persists through save/load.
  const dir = makeTempDir();
  saveTeamConfig(dir, second.team);
  const loaded = loadTeamConfig(dir);
  assert.equal(listServiceAccounts(loaded).length, 2);
  assert.equal(listServiceAccounts(loaded)[1].scope, 'admin');

  // Validation errors.
  assert.throws(() => createServiceAccount(team, { name: '', scope: 'run' }), /non-empty/);
  assert.throws(() => createServiceAccount(team, { name: 'x', scope: 'super' }), /scope/);
  assert.throws(() => revokeServiceAccount(team, 'not-an-id'), /sa-<uuid>/);
  assert.throws(() => serviceAccountVaultKey('not-an-id'), /sa-<uuid>/);
  assert.throws(
    () => validateTeamConfig({ ...team, serviceAccounts: [{ id: 'bad', name: 'x', scope: 'run', createdAt: 1 }] }),
    /sa-<uuid>/,
  );
});

// ---------------------------------------------------------------------------
// Vault NO_STORAGE
// ---------------------------------------------------------------------------

test('vault NO_STORAGE on: file untouched but get still reads; off: values flushed to disk', () => {
  const dir = makeTempDir();
  const storePath = path.join(dir, 'vault.json');
  const vault = new Vault({ storePath });
  assert.equal(vault.isNoStorage(), false);

  vault.setSecret('provider', 'xai', 'durable-key');
  const before = fs.readFileSync(storePath, 'utf8');
  assert.ok(fs.existsSync(storePath));

  vault.setNoStorage(true);
  assert.equal(vault.isNoStorage(), true);
  vault.setSecret('provider', 'openai', 'memory-only-key');
  assert.equal(fs.readFileSync(storePath, 'utf8'), before, 'store file must not change while NO_STORAGE is on');
  assert.equal(vault.getSecret('provider', 'openai'), 'memory-only-key');
  assert.equal(vault.getSecret('provider', 'xai'), 'durable-key');

  // Deleting while on also stays in memory only.
  vault.deleteSecret('provider', 'xai');
  assert.equal(vault.getSecret('provider', 'xai'), null);
  assert.equal(fs.readFileSync(storePath, 'utf8'), before);

  // Turning off flushes everything: the new secret appears and the
  // deletion sticks, visible to a fresh Vault on the same file.
  vault.setNoStorage(false);
  assert.equal(vault.isNoStorage(), false);
  assert.notEqual(fs.readFileSync(storePath, 'utf8'), before);
  const reopened = new Vault({ storePath });
  assert.equal(reopened.getSecret('provider', 'openai'), 'memory-only-key');
  assert.equal(reopened.getSecret('provider', 'xai'), null);
});

test('vault NO_STORAGE from construction: no file is created until it is turned off', () => {
  const dir = makeTempDir();
  const storePath = path.join(dir, 'vault.json');
  const vault = new Vault({ storePath, noStorage: true });
  assert.equal(vault.isNoStorage(), true);

  vault.setSecret('session', 'svc-1', 'tok-123');
  assert.equal(fs.existsSync(storePath), false, 'no store file while NO_STORAGE is on');
  assert.equal(vault.getSecret('session', 'svc-1'), 'tok-123');

  vault.setNoStorage(false);
  assert.equal(fs.existsSync(storePath), true);
  assert.equal(new Vault({ storePath }).getSecret('session', 'svc-1'), 'tok-123');

  // setNoStorage(true) twice / false twice is a no-op, not an error.
  vault.setNoStorage(false);
  vault.setNoStorage(true);
  vault.setNoStorage(true);
  assert.equal(vault.isNoStorage(), true);
});

// ---------------------------------------------------------------------------
// redactSecrets / redactBearer
// ---------------------------------------------------------------------------

test('redactSecrets replaces every occurrence and skips short/empty secrets', () => {
  assert.equal(redactSecrets('key sk-abc123 here sk-abc123', ['sk-abc123']), 'key <redacted> here <redacted>');
  assert.equal(
    redactSecrets('a SECRET1 b SECRET2 c', ['SECRET1', 'SECRET2']),
    'a <redacted> b <redacted> c',
  );
  // Short secrets (< 4 chars) and empty strings are ignored.
  assert.equal(redactSecrets('abc ab a', ['ab', 'a', '']), 'abc ab a');
  assert.equal(redactSecrets('nothing secret here', ['sk-xyz']), 'nothing secret here');
  assert.equal(redactSecrets('plain text', []), 'plain text');
  // Secrets containing regex metacharacters are matched literally.
  assert.equal(redactSecrets('token a+b*c? here', ['a+b*c?']), 'token <redacted> here');
});

test('redactBearer replaces Bearer tokens and keeps the word Bearer', () => {
  assert.equal(
    redactBearer('Authorization: Bearer sk-abc123XYZ'),
    'Authorization: Bearer <redacted>',
  );
  assert.equal(
    redactBearer('got Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature and Bearer xai-token-2'),
    'got Bearer <redacted> and Bearer <redacted>',
  );
  assert.equal(redactBearer('no auth here'), 'no auth here');
  assert.equal(redactBearer('Bearer'), 'Bearer');
});

// ---------------------------------------------------------------------------
// machine id: stable, persisted, mode 0600
// ---------------------------------------------------------------------------

test('machineId is stable across calls and stored in a 0600 file', () => {
  const dir = makeTempDir();
  const first = getOrCreateMachineId(dir);
  assert.match(first, UUID_RE);

  const filePath = path.join(dir, 'machine-id');
  assert.equal(fs.readFileSync(filePath, 'utf8').trim(), first);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);

  const second = getOrCreateMachineId(dir);
  assert.equal(second, first, 'same dir must yield the same id');

  // A corrupt id file is replaced instead of bricking startup.
  fs.writeFileSync(filePath, 'not-a-uuid\n', 'utf8');
  const third = getOrCreateMachineId(dir);
  assert.match(third, UUID_RE);
  assert.notEqual(third, first);
  assert.equal(getOrCreateMachineId(dir), third);

  assert.throws(() => getOrCreateMachineId(''), /non-empty/);
});
