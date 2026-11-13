/**
 * Tests for the local git workflow tools added in v0.97 (Team T6):
 * git_log, git_branch, git_branch_create, git_branch_delete,
 * git_show (packages/tools/src/gitWorkflowTools.ts).
 * git_blame already existed in codeTools.ts — it is tested here too,
 * through CODE_TOOLS, for the line range added in v0.97.
 *
 * Run after building the tools package:
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/git-workflow-v097.test.mjs
 *
 * The tools run the real `git` CLI against a throwaway repo created
 * in the OS temp dir (git init + commits via execFileSync) — no
 * network, no GitHub token, no fixture checked into the repo.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  GIT_WORKFLOW_TOOLS,
  GIT_WORKFLOW_TOOL_NAMES,
  createGitWorkflowTools,
  isGitRepo,
  validateBranchName,
  validateGitRef,
} from '../packages/tools/dist/gitWorkflowTools.js';
import { CODE_TOOLS } from '../packages/tools/dist/codeTools.js';

const tmpDirs = [];

function tmpDir(prefix = 'open-bot-gitwf-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
}

/** A repo with 2 commits on main + 1 file changed after the last commit. */
function fixtureRepo() {
  const dir = tmpDir();
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test User');
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello world\nsecond line\nthird line\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'first commit');
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello world\nsecond line changed\nthird line\n');
  fs.writeFileSync(path.join(dir, 'notes.md'), '# notes\nsome text\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'second commit by alice');
  // A staged-but-uncommitted change, so `git_show --cached` has
  // something to show (a bare working-tree edit would not appear).
  fs.writeFileSync(path.join(dir, 'notes.md'), '# notes\nsome text\nuncommitted line\n');
  git(dir, 'add', 'notes.md');
  return dir;
}

const CTX = (workspaceDir) => ({ workspaceDir, signal: undefined });
const tool = (name, tools = GIT_WORKFLOW_TOOLS) => tools.find((t) => t.definition.name === name);
const run = (name, args, workspaceDir) => tool(name).execute(args, CTX(workspaceDir));
// git_blame lives in CODE_TOOLS (codeTools.ts), not in the workflow file.
const runCode = (name, args, workspaceDir) =>
  tool(name, CODE_TOOLS).execute(args, CTX(workspaceDir));

// ---------------------------------------------------------------------------
// Registration + approval flags
// ---------------------------------------------------------------------------

test('git workflow: 5 tools, unique names, reads need no approval, writes do', () => {
  assert.deepEqual(GIT_WORKFLOW_TOOL_NAMES, [
    'git_log',
    'git_branch',
    'git_branch_create',
    'git_branch_delete',
    'git_show',
  ]);
  assert.equal(createGitWorkflowTools().length, 5);
  const names = GIT_WORKFLOW_TOOLS.map((t) => t.definition.name);
  assert.equal(new Set(names).size, names.length);
  for (const name of ['git_log', 'git_branch', 'git_show']) {
    assert.equal(tool(name).needsApproval, false, `${name} is read-only`);
  }
  for (const name of ['git_branch_create', 'git_branch_delete']) {
    assert.equal(tool(name).needsApproval, true, `${name} writes repo state`);
  }
  for (const t of GIT_WORKFLOW_TOOLS) {
    assert.ok(t.definition.description.length > 20, `${t.definition.name} needs a description`);
    assert.equal(t.definition.parameters.type, 'object');
  }
});

test('git workflow: isGitRepo / ref validation (pure helpers)', () => {
  const dir = tmpDir();
  assert.equal(isGitRepo(dir), false);
  git(dir, 'init', '-b', 'main');
  assert.equal(isGitRepo(dir), true);
  // Valid refs.
  for (const ref of ['HEAD', 'HEAD~1', 'HEAD^', 'main', 'feature/x', 'v1.2.3', 'abc1234', 'a'.repeat(40)]) {
    validateGitRef(ref);
  }
  // Invalid refs: ranges, reflog, leading dash, shell metacharacters.
  for (const ref of ['HEAD..main', 'main@{1}', '-rf', 'a;b', 'a|b', 'a b', '$(id)', 'a..b', '']) {
    assert.throws(() => validateGitRef(ref), /Invalid git revision/, ref);
  }
  for (const name of ['feature/x', 'fix-1', 'a.b_c/d']) validateBranchName(name);
  for (const name of ['-x', 'a..b', 'a b', 'a;b', '.lock', 'a.lock']) {
    assert.throws(() => validateBranchName(name), /Invalid branch name/, name);
  }
});

// ---------------------------------------------------------------------------
// git_log
// ---------------------------------------------------------------------------

test('git workflow: git_log lists commits newest-first with hash/date/author/subject', async () => {
  const dir = fixtureRepo();
  const out = await run('git_log', {}, dir);
  assert.ok(!out.startsWith('Error:'), out);
  const lines = out.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^[0-9a-f]{7}\t\d{4}-\d{2}-\d{2}\tTest User\tsecond commit by alice$/);
  assert.match(lines[1], /first commit$/);
});

test('git workflow: git_log limit / path / author / since filters', async () => {
  const dir = fixtureRepo();
  const limited = await run('git_log', { limit: 1 }, dir);
  assert.equal(limited.trim().split('\n').length, 1);
  assert.match(limited, /second commit/);

  const byPath = await run('git_log', { path: 'notes.md' }, dir);
  assert.equal(byPath.trim().split('\n').length, 1, 'only the second commit touched notes.md');
  assert.match(byPath, /second commit/);

  const byAuthor = await run('git_log', { author: 'Nobody Here' }, dir);
  assert.match(byAuthor, /no commits match/);

  // NOTE: git's own date parser stops filtering for years >= 2100
  // (verified on git 2.43: --since=2100-01-01 still lists the commit),
  // so the future-date case uses 2099.
  const since = await run('git_log', { since: '2099-01-01' }, dir);
  assert.match(since, /no commits match/);

  const badSince = await run('git_log', { since: 'yesterday' }, dir);
  assert.match(badSince, /^Error: Invalid "since"/);

  const badLimit = await run('git_log', { limit: 0 }, dir);
  assert.match(badLimit, /^Error: Argument "limit" must be an integer between 1 and 100/);
});

test('git workflow: git_log full includes the commit body', async () => {
  const dir = fixtureRepo();
  git(dir, 'commit', '--allow-empty', '-m', 'subject line', '-m', 'body paragraph here');
  const out = await run('git_log', { limit: 1, full: true }, dir);
  assert.match(out, /subject line/);
  assert.match(out, /body paragraph here/);
});

// ---------------------------------------------------------------------------
// git_branch / create / delete
// ---------------------------------------------------------------------------

test('git workflow: git_branch lists branches with the current one marked', async () => {
  const dir = fixtureRepo();
  git(dir, 'branch', 'feature-x');
  const out = await run('git_branch', {}, dir);
  assert.ok(!out.startsWith('Error:'), out);
  assert.match(out, /^\* main\s/m);
  assert.match(out, /^  feature-x\s/m);
});

test('git workflow: git_branch_create + git_branch_delete round-trip', async () => {
  const dir = fixtureRepo();
  const created = await run('git_branch_create', { name: 'topic/a' }, dir);
  assert.match(created, /Branch "topic\/a" created/);
  const list = await run('git_branch', {}, dir);
  assert.match(list, /topic\/a/);

  const createdAt = await run('git_branch_create', { name: 'from-head', startPoint: 'HEAD' }, dir);
  assert.match(createdAt, /Branch "from-head" created at HEAD/);

  const badName = await run('git_branch_create', { name: 'bad name' }, dir);
  assert.match(badName, /^Error: Invalid branch name/);
  const badStart = await run('git_branch_create', { name: 'ok-name', startPoint: 'main..HEAD' }, dir);
  assert.match(badStart, /^Error: Invalid git startPoint/);
  const dup = await run('git_branch_create', { name: 'topic/a' }, dir);
  assert.match(dup, /^Error: git branch failed/);

  const deleted = await run('git_branch_delete', { name: 'topic/a' }, dir);
  assert.match(deleted, /Branch "topic\/a" deleted/);
  const gone = await run('git_branch', {}, dir);
  assert.doesNotMatch(gone, /topic\/a/);

  const missing = await run('git_branch_delete', { name: 'no-such-branch' }, dir);
  assert.match(missing, /^Error: git branch failed/);
  const current = await run('git_branch_delete', { name: 'main' }, dir);
  assert.match(current, /^Error: git branch failed/);
});

test('git workflow: git_branch_delete refuses unmerged branches unless force', async () => {
  const dir = fixtureRepo();
  git(dir, 'checkout', '-b', 'unmerged');
  fs.writeFileSync(path.join(dir, 'only-here.txt'), 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'unmerged work');
  git(dir, 'checkout', 'main');
  const refused = await run('git_branch_delete', { name: 'unmerged' }, dir);
  assert.match(refused, /^Error: git branch failed/);
  const forced = await run('git_branch_delete', { name: 'unmerged', force: true }, dir);
  assert.match(forced, /Branch "unmerged" deleted/);
});

// ---------------------------------------------------------------------------
// git_show
// ---------------------------------------------------------------------------

test('git workflow: git_show shows a commit diff, --stat, and the staged diff', async () => {
  const dir = fixtureRepo();
  const head = await run('git_show', {}, dir);
  assert.ok(!head.startsWith('Error:'), head);
  assert.match(head, /second commit by alice/);
  assert.match(head, /notes\.md/);
  assert.match(head, /\+# notes/);

  const stat = await run('git_show', { stat: true }, dir);
  assert.match(stat, /notes\.md/);
  assert.doesNotMatch(stat, /\+# notes/);

  const staged = await run('git_show', { staged: true }, dir);
  assert.match(staged, /uncommitted line/);

  const bySha = await run('git_show', { revision: 'HEAD~1' }, dir);
  assert.match(bySha, /first commit/);

  const badRev = await run('git_show', { revision: 'HEAD..main' }, dir);
  assert.match(badRev, /^Error: Invalid git revision/);
  const noCommit = await run('git_show', { revision: 'deadbee' }, dir);
  assert.match(noCommit, /^Error: git show failed/);
});

test('git workflow: git_blame (codeTools) attributes each line to the right commit', async () => {
  const dir = fixtureRepo();
  // Default blame output has no subject — attribute by commit SHA:
  // lines 1+3 come from the first commit (boundary, `^` prefix),
  // line 2 from the second commit (HEAD).
  const firstSha = git(dir, 'rev-parse', '--short', 'HEAD~1').trim();
  const headSha = git(dir, 'rev-parse', '--short', 'HEAD').trim();
  const out = await runCode('git_blame', { path: 'hello.txt' }, dir);
  assert.ok(!out.startsWith('Error:'), out);
  const lines = out.trim().split('\n');
  assert.equal(lines.length, 3);
  // Blame abbreviates the SHA to its own length (longer than
  // --short when needed), so match on the short-SHA prefix + the
  // line number + content, not on the exact hash width.
  assert.ok(lines[0].startsWith(`^${firstSha}`), lines[0]);
  assert.ok(lines[0].endsWith('1) hello world'), lines[0]);
  assert.ok(lines[1].startsWith(headSha) && !lines[1].startsWith('^'), lines[1]);
  assert.ok(lines[1].endsWith('2) second line changed'), lines[1]);
  assert.ok(lines[2].startsWith(`^${firstSha}`), lines[2]);
  assert.ok(lines[2].endsWith('3) third line'), lines[2]);

  const ranged = await runCode('git_blame', { path: 'hello.txt', startLine: 2, endLine: 2 }, dir);
  assert.equal(ranged.trim().split('\n').length, 1);
  assert.ok(ranged.trim().startsWith(headSha));
  assert.ok(ranged.trim().endsWith('2) second line changed'));

  const badRange = await runCode('git_blame', { path: 'hello.txt', startLine: 3, endLine: 2 }, dir);
  assert.match(badRange, /^Error: "endLine" \(2\) must not be smaller than "startLine" \(3\)/);
  const missing = await runCode('git_blame', { path: 'nope.txt' }, dir);
  assert.match(missing, /^Error: git blame failed/);
});

// ---------------------------------------------------------------------------
// Sandbox: non-repo, escaping paths
// ---------------------------------------------------------------------------

test('git workflow: tools refuse a workspace that is not a git repo', async () => {
  const dir = tmpDir();
  for (const name of GIT_WORKFLOW_TOOL_NAMES) {
    const args = name === 'git_branch_create' || name === 'git_branch_delete' ? { name: 'x' } : {};
    const out = await run(name, args, dir);
    assert.match(out, /^Error: Workspace .* is not a git repository/, name);
  }
  // git_blame (codeTools) does not check isGitRepo itself — git fails
  // with a clear error instead.
  const blame = await runCode('git_blame', { path: 'a.txt' }, dir);
  assert.match(blame, /^Error: git blame failed/);
});

test('git workflow: a path escaping the workspace is rejected', async () => {
  const dir = fixtureRepo();
  const out = await run('git_log', { path: '../outside.txt' }, dir);
  assert.match(out, /^Error: Path escapes workspace/);
  const blame = await runCode('git_blame', { path: '/etc/passwd' }, dir);
  assert.match(blame, /^Error: Path escapes workspace/);
});
