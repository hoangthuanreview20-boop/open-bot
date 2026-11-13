/**
 * git_log tests (v0.98, sóng T6 — node:test, real git on temp repos).
 *
 * Covers packages/tools/src/gitLog.ts:
 *  - lists recent commits (hash, date, author, subject) in a real repo
 *  - filters: author / path / since / until / grep
 *  - stat=true includes a diffstat
 *  - validation: limit bounds, bad dates, path escaping the workspace
 *  - non-repo workspace -> clear error, not a crash
 *  - parseGitLogOutput / formatGitLogCommits round-trip
 *
 * Imports the BUILT tools — build first:
 *   npm run build --workspace=@open-bot/tools
 * then: node --test tests/git-log-v098.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

import {
  gitLogTool,
  GIT_LOG_TOOLS,
  parseGitLogOutput,
  formatGitLogCommits,
} from '../packages/tools/dist/gitLog.js';

const ctx = (dir) => ({ workspaceDir: dir, botId: 'test-bot' });
const run = (dir, args) => gitLogTool.execute(args, ctx(dir));

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-gitlog-test-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email "alice@example.com"', { cwd: dir });
  execSync('git config user.name "Alice"', { cwd: dir });
  return dir;
}

function commit(dir, file, content, message, author, date) {
  const target = path.join(dir, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  execSync(`git add ${file}`, { cwd: dir });
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  if (author) {
    const [name, email] = author;
    execSync(`git -c user.name="${name}" -c user.email="${email}" commit -q -m "${message}"`, { cwd: dir, env });
  } else {
    execSync(`git commit -q -m "${message}"`, { cwd: dir, env });
  }
}

test('git_log: registered once in GIT_LOG_TOOLS, read-only (no approval)', () => {
  assert.equal(GIT_LOG_TOOLS.length, 1);
  assert.equal(GIT_LOG_TOOLS[0].definition.name, 'git_log');
  assert.equal(gitLogTool.needsApproval, false);
});

test('git_log: lists commits newest first with hash/date/author/subject', async () => {
  const dir = makeRepo();
  commit(dir, 'a.txt', 'one\n', 'first commit', null, '2026-11-01T10:00:00');
  commit(dir, 'b.txt', 'two\n', 'second commit', null, '2026-11-02T10:00:00');
  const out = await run(dir, {});
  assert.match(out, /second commit/);
  assert.match(out, /first commit/);
  assert.ok(out.indexOf('second commit') < out.indexOf('first commit'), 'newest first');
  assert.match(out, /2026-11-02/);
  assert.match(out, /Alice/);
});

test('git_log: limit + author + grep filters', async () => {
  const dir = makeRepo();
  commit(dir, 'a.txt', 'one\n', 'alpha work', ['Alice', 'alice@example.com'], '2026-11-01T10:00:00');
  commit(dir, 'b.txt', 'two\n', 'beta work', ['Bob', 'bob@example.com'], '2026-11-02T10:00:00');
  commit(dir, 'c.txt', 'three\n', 'gamma fix', ['Alice', 'alice@example.com'], '2026-11-03T10:00:00');
  const limited = await run(dir, { limit: 1 });
  assert.match(limited, /gamma fix/);
  assert.doesNotMatch(limited, /beta work/);
  const byAlice = await run(dir, { author: 'Alice' });
  assert.match(byAlice, /alpha work/);
  assert.match(byAlice, /gamma fix/);
  assert.doesNotMatch(byAlice, /beta work/);
  const byGrep = await run(dir, { grep: 'beta' });
  assert.match(byGrep, /beta work/);
  assert.doesNotMatch(byGrep, /alpha work/);
  const none = await run(dir, { grep: 'zzz-no-such-message' });
  assert.equal(none, '(no commits match)');
});

test('git_log: path + since/until filters', async () => {
  const dir = makeRepo();
  commit(dir, 'docs/a.md', 'one\n', 'docs change', null, '2026-11-01T10:00:00');
  commit(dir, 'src/a.ts', 'two\n', 'code change', null, '2026-11-05T10:00:00');
  const byPath = await run(dir, { path: 'docs' });
  assert.match(byPath, /docs change/);
  assert.doesNotMatch(byPath, /code change/);
  const bySince = await run(dir, { since: '2026-11-03' });
  assert.match(bySince, /code change/);
  assert.doesNotMatch(bySince, /docs change/);
  const byUntil = await run(dir, { until: '2026-11-03' });
  assert.match(byUntil, /docs change/);
  assert.doesNotMatch(byUntil, /code change/);
});

test('git_log: stat=true includes a diffstat', async () => {
  const dir = makeRepo();
  commit(dir, 'a.txt', 'one\n', 'first commit', null, '2026-11-01T10:00:00');
  const out = await run(dir, { stat: true });
  assert.match(out, /first commit/);
  assert.match(out, /a\.txt/);
  assert.match(out, /1 file changed/);
});

test('git_log: validation errors are clear, not crashes', async () => {
  const dir = makeRepo();
  commit(dir, 'a.txt', 'one\n', 'first commit', null, '2026-11-01T10:00:00');
  assert.match(await run(dir, { limit: 0 }), /Error: Argument "limit" must be between 1 and 100/);
  assert.match(await run(dir, { limit: 101 }), /Error: Argument "limit" must be between 1 and 100/);
  assert.match(await run(dir, { limit: 1.5 }), /Error: Argument "limit" must be an integer/);
  assert.match(await run(dir, { since: 'yesterday' }), /Error: Argument "since" must be a date/);
  assert.match(await run(dir, { since: '2026-13-40' }), /Error: Argument "since" is not a valid date/);
  assert.match(await run(dir, { path: '../outside.txt' }), /Error:/);
  assert.match(await run(dir, { path: '/etc/passwd' }), /Error:/);
});

test('git_log: non-repo workspace returns a clear error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-gitlog-norepo-'));
  const out = await run(dir, {});
  assert.match(out, /Error: git log failed/);
});

test('git_log: parse + format round-trip', () => {
  const raw = 'abc123\x1fAlice\x1f2026-11-02\x1fsecond commit\x1fbody line\x1e' + 'def456\x1fBob\x1f2026-11-01\x1ffirst commit\x1f\x1e';
  const commits = parseGitLogOutput(raw);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].hash, 'abc123');
  assert.equal(commits[0].subject, 'second commit');
  assert.equal(commits[0].body, 'body line');
  assert.equal(commits[1].body, '');
  const formatted = formatGitLogCommits(commits);
  assert.match(formatted, /abc123 2026-11-02 Alice \| second commit/);
  assert.match(formatted, /body line/);
  assert.deepEqual(parseGitLogOutput(''), []);
  assert.deepEqual(parseGitLogOutput('\n'), []);
});
