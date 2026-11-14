/**
 * Tests for the v1.02 rescue skills (discovery, matching, token
 * budget, script runner, self-evolving skills) and sandbox hardening
 * v2 (allowlist, profiles, quota, audit, enforcer, config store).
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/skills-sandbox-v102.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  BUILTIN_SKILLS,
  EvolvedSkillStore,
  SandboxAuditLogger,
  SandboxConfigStore,
  SandboxDeniedError,
  SandboxEnforcer,
  SandboxQuotaTracker,
  SkillTokenBudget,
  checkAllowlist,
  draftSkillFromTasks,
  getBuiltinSandboxProfile,
  isCommandAllowed,
  isHostAllowed,
  isPathAllowed,
  matchSkillsWithConfig,
  parseSkillMarkdown,
  runSkillScript,
  scanDiscoveryRoots,
  validateSandboxProfile,
} from '../packages/core/dist/index.js';

/** Built-in skills parsed with bodies loaded (BUILTIN_SKILLS is raw markdown). */
const SKILLS = BUILTIN_SKILLS.map((text) => parseSkillMarkdown(text, 'builtin'));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-skills-v102-'));
}

function writeSkill(dir, name, description, body) {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
    'utf8',
  );
  return skillDir;
}

test('discovery: scans roots, dedupes by name (first root wins), reports skipped roots', () => {
  const dir = tmpDir();
  const rootA = path.join(dir, 'a');
  const rootB = path.join(dir, 'b');
  writeSkill(rootA, 'git-helper', 'Helps with git.', 'Run git commands.');
  writeSkill(rootA, 'writer', 'Writes docs.', 'Write documentation.');
  writeSkill(rootB, 'git-helper', 'A different git helper.', 'Other body.');
  writeSkill(rootB, 'tester', 'Runs tests.', 'Run the test suite.');
  const result = scanDiscoveryRoots([
    { dir: rootA, source: 'workspace' },
    { dir: rootB, source: 'workspace' },
    { dir: path.join(dir, 'missing'), source: 'home' },
  ]);
  assert.equal(result.skills.length, 3);
  assert.deepEqual(result.duplicates, ['git-helper']);
  assert.equal(result.skippedRoots.length, 1);
  const names = result.skills.map((s) => s.name).sort();
  assert.deepEqual(names, ['git-helper', 'tester', 'writer']);
  const git = result.skills.find((s) => s.name === 'git-helper');
  assert.equal(git.dir, path.join(rootA, 'git-helper'), 'first root wins');
  assert.match(git.provenance, /workspace/);
});

test('matching: built-in skills match their task; name mention boosts; threshold + limit apply', () => {
  assert.equal(SKILLS.length, 11);
  const matches = matchSkillsWithConfig(SKILLS, 'Please write a commit message for this change.');
  assert.ok(matches.length >= 1);
  assert.equal(matches[0].skill.name, 'commit-message');
  const release = matchSkillsWithConfig(SKILLS, 'Draft release notes for version 2.0.');
  assert.equal(release[0].skill.name, 'release-notes');
  const none = matchSkillsWithConfig(SKILLS, 'Quantum field theory homework about string theory.');
  assert.equal(none.length, 0);
  const limited = matchSkillsWithConfig(SKILLS, 'write', { limit: 1, threshold: 0 });
  assert.equal(limited.length, 1);
});

test('token budget: keeps skills until the budget runs out, drops the rest', () => {
  const budget = new SkillTokenBudget({ maxTokens: 1000 });
  const result = budget.fit(SKILLS);
  assert.ok(result.kept.length > 0);
  assert.ok(result.dropped.length > 0);
  assert.ok(budget.usedTokens <= 1000);
  assert.equal(budget.remainingTokens, 1000 - budget.usedTokens);
  assert.equal(result.costs.length, SKILLS.length);
  assert.ok(result.costs.every((c) => c.tokens > 0));
  // A generous budget keeps everything.
  const big = new SkillTokenBudget({ maxTokens: 1_000_000 });
  assert.equal(big.fit(SKILLS).dropped.length, 0);
});

test('script runner: runs an allowlisted script, refuses others and escapes', async () => {
  const dir = tmpDir();
  const skillDir = writeSkill(dir, 'demo', 'Demo skill.', 'Demo.');
  const scriptsDir = path.join(skillDir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  const scriptPath = path.join(scriptsDir, 'hello.sh');
  fs.writeFileSync(scriptPath, '#!/bin/sh\necho "hello $1"\n', { mode: 0o755 });
  const result = await runSkillScript(skillDir, 'hello.sh', ['hello.sh'], ['world']);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /hello world/);
  await assert.rejects(runSkillScript(skillDir, 'evil.sh', ['hello.sh']), /not in the skill's allowed scripts/);
  await assert.rejects(
    runSkillScript(skillDir, '../escape.sh', ['hello.sh', '../escape.sh']),
    /escapes the skill scripts directory/,
  );
  await assert.rejects(runSkillScript(skillDir, 'missing.sh', ['missing.sh']), /not found/);
});

test('evolved skills: propose from repeated tasks, approve writes SKILL.md, feedback evolves', () => {
  const dir = tmpDir();
  const store = new EvolvedSkillStore(dir, path.join(dir, 'user-skills'));
  const tasks = [
    { id: 't1', title: 'Fix bug', tools: ['read_file', 'write_file'], success: true, at: '2026-11-14T00:00:00Z' },
    { id: 't2', title: 'Fix bug', tools: ['read_file', 'write_file'], success: true, at: '2026-11-14T01:00:00Z' },
    { id: 't3', title: 'Other', tools: ['web_search'], success: true, at: '2026-11-14T02:00:00Z' },
  ];
  const proposed = store.proposeSkillsFromTasks(tasks);
  assert.equal(proposed.length, 1, 'only the repeated tool sequence is proposed');
  assert.equal(proposed[0].status, 'proposed');
  const draft = draftSkillFromTasks(tasks.slice(0, 2));
  assert.ok(draft);
  assert.match(draft.body, /read_file/);

  const approved = store.approveSkill(proposed[0].id);
  assert.equal(approved.status, 'approved');
  assert.ok(fs.existsSync(path.join(dir, 'user-skills', approved.name, 'SKILL.md')));

  // Feedback: 2 failures + 1 success -> evolve bumps the version.
  store.recordFeedback(approved.id, 'failure', 'Used the wrong file first.');
  store.recordFeedback(approved.id, 'failure', 'Missed the test file.');
  store.recordFeedback(approved.id, 'success');
  const evolved = store.maybeEvolveSkill(approved.id);
  assert.ok(evolved);
  assert.equal(evolved.version, approved.version + 1);
  assert.match(evolved.body, /Lessons learned/);
  assert.match(evolved.body, /wrong file/);
  assert.equal(store.deleteSkill(approved.id), true);
  assert.equal(store.list().length, 0);
  assert.throws(() => store.approveSkill('nope'), /unknown evolved skill/);
});

test('allowlist: hosts, paths and commands checked independently', () => {
  const allowlist = {
    hosts: ['api.github.com'],
    hostSuffixes: ['.githubusercontent.com'],
    paths: ['.'],
    commands: ['node', 'git'],
  };
  assert.equal(isHostAllowed('api.github.com', allowlist), true);
  assert.equal(isHostAllowed('raw.githubusercontent.com', allowlist), true);
  assert.equal(isHostAllowed('evil.example.com', allowlist), false);
  assert.equal(isPathAllowed('src/index.ts', allowlist), true);
  assert.equal(isPathAllowed('./src/index.ts', allowlist), true);
  assert.equal(isPathAllowed('/etc/passwd', allowlist), false);
  assert.equal(isPathAllowed('../escape.txt', allowlist), false);
  assert.equal(isCommandAllowed('git status', allowlist), true);
  assert.equal(isCommandAllowed('rm -rf /', allowlist), false);
  const blocked = checkAllowlist({ host: 'evil.example.com' }, allowlist);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.reason);
});

test('profiles: strict blocks shell+network, standard allows allowlisted hosts', () => {
  const strict = getBuiltinSandboxProfile('strict');
  assert.equal(strict.shellEnabled, false);
  assert.equal(strict.networkEnabled, false);
  const standard = getBuiltinSandboxProfile('standard');
  assert.equal(standard.shellEnabled, true);
  assert.equal(validateSandboxProfile(standard).length, 0);
  assert.equal(getBuiltinSandboxProfile('nope'), undefined);
});

test('enforcer: always-denied credential paths blocked under every profile; allowlist enforced', () => {
  const enforcer = new SandboxEnforcer({ profile: getBuiltinSandboxProfile('standard') });
  assert.equal(enforcer.profileName, 'standard');
  assert.throws(() => enforcer.checkWrite('.env'), SandboxDeniedError);
  assert.throws(() => enforcer.checkRead('id_rsa'), SandboxDeniedError);
  assert.throws(() => enforcer.checkRead('.git/config'), SandboxDeniedError);
  enforcer.checkWrite('src/index.ts');
  enforcer.checkCommand('git status');
  assert.throws(() => enforcer.checkCommand('rm -rf /'), SandboxDeniedError);
  assert.throws(() => enforcer.checkNetwork('evil.example.com'), SandboxDeniedError);
  enforcer.checkNetwork('api.github.com');

  const strict = new SandboxEnforcer({ profile: getBuiltinSandboxProfile('strict') });
  assert.throws(() => strict.checkCommand('ls'), /shell is disabled/);
  assert.throws(() => strict.checkNetwork('api.github.com'), /network is disabled/);
});

test('quota: runs and writes counted; limits reported before they are hit', () => {
  const tracker = new SandboxQuotaTracker({ maxRuns: 2, maxWriteBytes: 100 });
  assert.equal(tracker.check().allowed, true);
  tracker.recordRun(50, 1, 10);
  tracker.recordRun(40, 1, 20);
  assert.equal(tracker.current.runs, 2);
  assert.equal(tracker.current.bytesWritten, 90);
  assert.equal(tracker.check().allowed, false);
  assert.equal(tracker.checkWrite(20).allowed, false, 'write would exceed the byte quota');
  assert.equal(tracker.checkWrite(5).allowed, true);
  const unlimited = new SandboxQuotaTracker({ maxRuns: 0 });
  assert.equal(unlimited.check().allowed, true);
});

test('sandbox audit: appends entries, reads newest first, filters denied', () => {
  const dir = tmpDir();
  const logger = new SandboxAuditLogger(path.join(dir, 'audit.jsonl'));
  logger.append({ at: new Date().toISOString(), botId: 'b1', action: 'write', target: 'a.txt', allowed: true });
  logger.append({ at: new Date().toISOString(), botId: 'b1', action: 'write', target: '.env', allowed: false, reason: 'sensitive' });
  const entries = logger.read();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].target, '.env', 'newest first');
  assert.equal(logger.denied().length, 1);
  const reloaded = new SandboxAuditLogger(path.join(dir, 'audit.jsonl'));
  assert.equal(reloaded.read().length, 2);
});

test('config store: per-bot profile assignment persists; unknown profiles rejected', () => {
  const dir = tmpDir();
  const store = new SandboxConfigStore(path.join(dir, 'sandbox-config.json'));
  assert.equal(store.profileForBot('bot-1'), 'standard');
  store.setProfileForBot('bot-1', 'strict');
  assert.equal(store.profileForBot('bot-1'), 'strict');
  assert.throws(() => store.setProfileForBot('bot-1', 'nope'), /unknown sandbox profile/);
  const reloaded = new SandboxConfigStore(path.join(dir, 'sandbox-config.json'));
  assert.equal(reloaded.profileForBot('bot-1'), 'strict');
  assert.ok(reloaded.getProfile('strict'));
});
