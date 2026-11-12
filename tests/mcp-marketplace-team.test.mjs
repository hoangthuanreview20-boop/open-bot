/**
 * MCP marketplace + team sharing tests (node:test).
 * Imports the BUILT core package — run the build first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-marketplace-team.test.mjs
 *
 * No real keys/tokens anywhere here: marketplace entries only name the
 * credential a server needs; tests use placeholder values only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  listAvailable,
  getAvailable,
  install,
  uninstall,
  listInstalled,
} from '../packages/core/dist/mcp/marketplace.js';
import {
  loadTeamConfig,
  saveTeamConfig,
  addMember,
  removeMember,
  setRole,
  shareBot,
  unshareBot,
  listSharedBots,
  canUseBot,
  canEditBot,
} from '../packages/core/dist/team/team.js';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readMcpJson(ws) {
  return JSON.parse(fs.readFileSync(path.join(ws, '.open-bot', 'mcp.json'), 'utf8'));
}

// --- marketplace -----------------------------------------------------------

test('marketplace: listAvailable returns exactly the 8 built-in servers', () => {
  const servers = listAvailable();
  assert.equal(servers.length, 8);
  const ids = servers.map((s) => s.id).sort();
  assert.deepEqual(ids, [
    'brave-search',
    'fetch',
    'filesystem',
    'git',
    'github',
    'memory',
    'postgres',
    'sqlite',
  ]);
  for (const s of servers) {
    assert.match(s.id, /^[A-Za-z0-9_-]+$/);
    assert.ok(s.name && s.description);
    assert.ok(s.transport === 'stdio' || s.transport === 'http');
    assert.ok(Array.isArray(s.tags));
  }
  // The three keyed servers name only the credential, never a value.
  const keyed = Object.fromEntries(servers.map((s) => [s.id, s.needsKey ?? null]));
  assert.match(keyed['brave-search'], /BRAVE_API_KEY/);
  assert.match(keyed['github'], /GITHUB_PERSONAL_ACCESS_TOKEN/);
  assert.match(keyed['postgres'], /connection string/i);
  assert.equal(keyed['filesystem'], null);
  assert.equal(keyed['memory'], null);
});

test('marketplace: listAvailable(baseDir) seeds the registry file', () => {
  const base = tmpDir('open-bot-mkt-reg-');
  const servers = listAvailable(base);
  assert.equal(servers.length, 8);
  const reg = JSON.parse(
    fs.readFileSync(path.join(base, 'marketplace', 'mcp-servers.json'), 'utf8'),
  );
  assert.equal(reg.servers.length, 8);
  // Second call reads the file back, same result.
  assert.deepEqual(listAvailable(base), servers);
});

test('marketplace: getAvailable finds one entry, unknown id -> undefined', () => {
  assert.equal(getAvailable('memory').name, 'Memory');
  assert.equal(getAvailable('no-such-server'), undefined);
  assert.throws(() => getAvailable('bad id!'), /must match/);
});

test('marketplace: install writes entry and keeps pre-existing servers', () => {
  const ws = tmpDir('open-bot-mkt-install-');
  fs.mkdirSync(path.join(ws, '.open-bot'), { recursive: true });
  fs.writeFileSync(
    path.join(ws, '.open-bot', 'mcp.json'),
    JSON.stringify({ servers: { existing: { command: 'node', args: ['server.js'] } } }),
    'utf8',
  );
  const res = install('memory', ws);
  assert.equal(res.config.name, 'memory');
  assert.equal(res.config.command, 'npx');
  assert.deepEqual(res.config.args, ['-y', '@modelcontextprotocol/server-memory']);
  assert.deepEqual(res.nextSteps, []);
  const after = readMcpJson(ws);
  assert.deepEqual(after.servers.existing, { command: 'node', args: ['server.js'] });
  assert.ok(after.servers.memory);
  assert.deepEqual(listInstalled(ws).map((s) => s.name).sort(), ['existing', 'memory']);
});

test('marketplace: install of a keyed server writes no credential and returns guidance', () => {
  const ws = tmpDir('open-bot-mkt-key-');
  const res = install('brave-search', ws);
  assert.match(res.nextSteps.join(' '), /BRAVE_API_KEY/);
  const raw = fs.readFileSync(path.join(ws, '.open-bot', 'mcp.json'), 'utf8');
  assert.ok(!raw.includes('BRAVE_API_KEY'), 'no credential name/value written to mcp.json');
  assert.ok(!raw.includes('sk-') && !raw.includes('token'));
});

test('marketplace: install with placeholder arg tells the user to replace it', () => {
  const ws = tmpDir('open-bot-mkt-ph-');
  const res = install('filesystem', ws);
  assert.ok(res.nextSteps.some((s) => s.includes('<allowed-directory>')));
  // Overrides can replace the placeholder args.
  const ws2 = tmpDir('open-bot-mkt-ov-');
  const res2 = install('filesystem', ws2, { args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] });
  assert.deepEqual(res2.nextSteps, []);
});

test('marketplace: install with invalid args overrides throws, nothing written', () => {
  const ws = tmpDir('open-bot-mkt-ovbad-');
  // v0.84e: the IPC layer (requireStringArray) and buildServerConfig
  // both reject non-array / non-string args before mcp.json is touched.
  assert.throws(() => install('memory', ws, { args: 'not-an-array' }), /must be an array of strings/);
  assert.throws(() => install('memory', ws, { args: ['-y', 42] }), /must be an array of strings/);
  assert.equal(
    fs.existsSync(path.join(ws, '.open-bot', 'mcp.json')),
    false,
    'no mcp.json written after a rejected install',
  );
});

test('marketplace: install unknown/invalid id -> clear error; reinstall -> error', () => {
  const ws = tmpDir('open-bot-mkt-err-');
  assert.throws(() => install('no-such-server', ws), /Unknown MCP marketplace server/);
  assert.throws(() => install('bad id!', ws), /must match/);
  install('fetch', ws);
  assert.throws(() => install('fetch', ws), /already installed/);
});

test('marketplace: uninstall removes only that entry, unknown -> error', () => {
  const ws = tmpDir('open-bot-mkt-un-');
  install('memory', ws);
  install('fetch', ws);
  const removed = uninstall('memory', ws);
  assert.equal(removed.name, 'memory');
  assert.deepEqual(listInstalled(ws).map((s) => s.name), ['fetch']);
  assert.throws(() => uninstall('memory', ws), /not installed/);
  assert.throws(() => uninstall('bad id!', ws), /must match/);
});

// --- team ------------------------------------------------------------------

function teamWithMembers() {
  let team = loadTeamConfig(tmpDir('open-bot-team-unused-')); // default team
  team = addMember(team, { userId: 'u-admin', name: 'Admin', role: 'admin' });
  team = addMember(team, { userId: 'u-member', name: 'Member', role: 'member' });
  team = addMember(team, { userId: 'u-member2', name: 'Member 2', role: 'member' });
  team = addMember(team, { userId: 'u-viewer', name: 'Viewer', role: 'viewer' });
  return team;
}

test('team: add/remove/setRole with validation', () => {
  let team = loadTeamConfig(tmpDir('open-bot-team-missing-'));
  assert.equal(team.id, 'default');
  assert.equal(team.name, 'Default team');
  assert.deepEqual(team.members, []);
  assert.deepEqual(team.sharedBots, []);
  assert.match(team.teamId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(team.serviceAccounts, []);
  team = addMember(team, { userId: 'u1', name: 'One', role: 'member' });
  assert.equal(team.members.length, 1);
  assert.throws(() => addMember(team, { userId: 'u1', name: 'Dup', role: 'member' }), /already exists/);
  assert.throws(() => addMember(team, { userId: 'bad id!', name: 'Bad', role: 'member' }), /must match/);
  assert.throws(() => addMember(team, { userId: 'u2', name: 'Two', role: 'superuser' }), /must be one of/);
  team = setRole(team, 'u1', 'admin');
  assert.equal(team.members[0].role, 'admin');
  assert.throws(() => setRole(team, 'u1', 'superuser'), /must be one of/);
  assert.throws(() => setRole(team, 'ghost', 'admin'), /does not exist/);
  team = removeMember(team, 'u1');
  assert.equal(team.members.length, 0);
  assert.throws(() => removeMember(team, 'u1'), /does not exist/);
});

test('team: share/unshare and listSharedBots', () => {
  let team = teamWithMembers();
  team = shareBot(team, 'bot-a', 'u-member');
  team = shareBot(team, 'bot-b', 'u-admin');
  assert.deepEqual(listSharedBots(team), ['bot-a', 'bot-b']);
  assert.throws(() => shareBot(team, 'bot-a', 'u-admin'), /already shared/);
  assert.throws(() => shareBot(team, 'bot-c', 'u-viewer'), /viewers cannot share/);
  assert.throws(() => shareBot(team, 'bot-c', 'ghost'), /not a team member/);
  assert.throws(() => shareBot(team, 'bad id!', 'u-admin'), /must match/);
  team = unshareBot(team, 'bot-a');
  assert.deepEqual(listSharedBots(team), ['bot-b']);
  assert.throws(() => unshareBot(team, 'bot-a'), /not shared/);
});

test('team: canUseBot — admin/member yes, viewer no, non-member no, unshared no', () => {
  let team = teamWithMembers();
  team = shareBot(team, 'bot-a', 'u-member');
  assert.equal(canUseBot(team, 'u-admin', 'bot-a'), true);
  assert.equal(canUseBot(team, 'u-member', 'bot-a'), true);
  assert.equal(canUseBot(team, 'u-member2', 'bot-a'), true);
  assert.equal(canUseBot(team, 'u-viewer', 'bot-a'), false);
  assert.equal(canUseBot(team, 'ghost', 'bot-a'), false);
  assert.equal(canUseBot(team, 'u-admin', 'bot-not-shared'), false);
});

test('team: canEditBot — admin any shared bot, member only own, viewer never', () => {
  let team = teamWithMembers();
  team = shareBot(team, 'bot-a', 'u-member');
  team = shareBot(team, 'bot-b', 'u-member2');
  assert.equal(canEditBot(team, 'u-admin', 'bot-a'), true);
  assert.equal(canEditBot(team, 'u-admin', 'bot-b'), true);
  assert.equal(canEditBot(team, 'u-member', 'bot-a'), true);
  assert.equal(canEditBot(team, 'u-member', 'bot-b'), false);
  assert.equal(canEditBot(team, 'u-member2', 'bot-b'), true);
  assert.equal(canEditBot(team, 'u-member2', 'bot-a'), false);
  assert.equal(canEditBot(team, 'u-viewer', 'bot-a'), false);
  assert.equal(canEditBot(team, 'ghost', 'bot-a'), false);
  assert.equal(canEditBot(team, 'u-admin', 'bot-not-shared'), false);
});

test('team: load/save round-trip, legacy sharedBotIds migrates', () => {
  const base = tmpDir('open-bot-team-rt-');
  let team = teamWithMembers();
  team = shareBot(team, 'bot-a', 'u-member');
  saveTeamConfig(base, team);
  const loaded = loadTeamConfig(base);
  assert.deepEqual(loaded, team);
  // Legacy file with sharedBotIds: string[] loads with unknown owner.
  const base2 = tmpDir('open-bot-team-legacy-');
  fs.writeFileSync(
    path.join(base2, 'team.json'),
    JSON.stringify({
      id: 't1',
      name: 'Legacy',
      members: [{ userId: 'u-admin', name: 'Admin', role: 'admin' }],
      sharedBotIds: ['bot-x'],
    }),
    'utf8',
  );
  const legacy = loadTeamConfig(base2);
  assert.deepEqual(legacy.sharedBots, [{ botId: 'bot-x', sharedBy: '' }]);
  assert.equal(canEditBot(legacy, 'u-admin', 'bot-x'), true);
});

test('team: invalid team.json -> clear error', () => {
  const base = tmpDir('open-bot-team-bad-');
  fs.writeFileSync(path.join(base, 'team.json'), '{not json', 'utf8');
  assert.throws(() => loadTeamConfig(base), /not valid JSON/);
  fs.writeFileSync(
    path.join(base, 'team.json'),
    JSON.stringify({ id: 't', name: 'T', members: [{ userId: 'u', name: 'U', role: 'nope' }], sharedBots: [] }),
    'utf8',
  );
  assert.throws(() => loadTeamConfig(base), /must be one of/);
});
