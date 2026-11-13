/**
 * Merge regression tests (v0.98 coordinator — node:test, real git on temp repos).
 *
 * Locks in the three merge decisions where v0.97 and v0.98 T6 built the
 * same thing twice:
 *  1. `git_log` is registered EXACTLY ONCE in the default tool factory
 *     (v0.97's gitWorkflowTools one — T6's standalone gitLogTool is NOT
 *     in ALL_TOOLS, see packages/tools/src/gitLog.ts header), and the
 *     registered tool carries T6's `until` / `grep` / `stat` filters.
 *  2. `validateAppHtml` returns BOTH result shapes (`findings` coded,
 *     v0.97; `errors` Vietnamese strings, v0.98) and enforces the
 *     stricter allowlist policy (storage / external links block).
 *  3. `buildAppCsp` carries both waves' directives (`frame-src` from
 *     T6, `frame-ancestors` from v0.97).
 *
 * Imports the BUILT core + tools — build first:
 *   npm run build
 * then: node --test tests/git-log-merge-v098.test.mjs
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { BotMemory, defaultToolFactory } from '../packages/core/dist/index.js';
import {
  buildAppCsp,
  validateAppHtml,
} from '../packages/core/dist/mcp/apps.js';
import {
  GIT_WORKFLOW_TOOLS,
  createGitWorkflowTools,
} from '../packages/tools/dist/gitWorkflowTools.js';

const tmpDirs = [];
function tmpDir(prefix = 'open-bot-merge098-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
}

/** Repo with 3 commits: two by Alice (one about "alpha"), one by Bob. */
function fixtureRepo() {
  const dir = tmpDir();
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'alice@example.invalid');
  git(dir, 'config', 'user.name', 'Alice');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'alpha: first');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'alpha: second');
  git(dir, 'config', 'user.email', 'bob@example.invalid');
  git(dir, 'config', 'user.name', 'Bob');
  fs.writeFileSync(path.join(dir, 'c.txt'), 'c\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'beta: third by bob');
  return dir;
}

const CTX = (workspaceDir) => ({ workspaceDir, signal: undefined });
const workflowTool = (name) =>
  createGitWorkflowTools().find((t) => t.definition.name === name);

// ---------------------------------------------------------------------------
// 1. git_log: registered once, with T6's filters
// ---------------------------------------------------------------------------

test('merge v098: git_log registered exactly once in the default factory', () => {
  const ws = tmpDir();
  const mem = new BotMemory(ws);
  try {
    const tools = defaultToolFactory(mem, ws, 'bot-merge');
    const names = tools.map((t) => t.definition.name);
    assert.equal(
      names.filter((n) => n === 'git_log').length,
      1,
      'git_log must appear exactly once (v0.97 workflow + v0.98 T6 built it twice)',
    );
    assert.equal(new Set(names).size, names.length, 'no duplicate tool names at all');
  } finally {
    mem.close();
  }
});

test('merge v098: registered git_log has until/grep/stat params (ported from T6)', async () => {
  const dir = fixtureRepo();
  const gitLog = workflowTool('git_log');
  assert.ok(gitLog, 'git_log must be in the workflow set');
  const props = Object.keys(gitLog.definition.parameters.properties);
  for (const p of ['limit', 'path', 'author', 'since', 'until', 'grep', 'stat', 'full']) {
    assert.ok(props.includes(p), `git_log must expose param ${p}`);
  }
  // grep filters by message text.
  const grepped = await gitLog.execute({ grep: 'alpha' }, CTX(dir));
  assert.match(grepped, /alpha: first/);
  assert.match(grepped, /alpha: second/);
  assert.doesNotMatch(grepped, /beta: third/);
  // until cuts off the newest commit (all three are "now", so a past
  // date matches nothing; a far-future date matches everything).
  const none = await gitLog.execute({ until: '2000-01-01' }, CTX(dir));
  assert.match(none, /no commits match/);
  const all = await gitLog.execute({ until: '2099-01-01' }, CTX(dir));
  assert.match(all, /beta: third/);
  // stat adds a diffstat without changing the one-line-per-commit list.
  const withStat = await gitLog.execute({ limit: 1, stat: true }, CTX(dir));
  assert.match(withStat, /beta: third/);
  assert.match(withStat, /c\.txt/);
  assert.match(withStat, /1 file changed/);
  // Bad until is rejected with the same message shape as since.
  const badUntil = await gitLog.execute({ until: 'yesterday' }, CTX(dir));
  assert.match(badUntil, /^Error: Invalid "until"/);
  assert.ok(GIT_WORKFLOW_TOOLS.length >= 5, 'workflow set still exports its tools');
});

// ---------------------------------------------------------------------------
// 2. validateAppHtml: unified shape + strict policy
// ---------------------------------------------------------------------------

test('merge v098: validateAppHtml returns findings AND errors, strict policy', () => {
  const ok = validateAppHtml('<p>hi</p>');
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.findings, []);
  assert.deepEqual(ok.errors, []);
  const blocked = validateAppHtml('<script>localStorage.setItem("k", "v")</script>');
  assert.equal(blocked.valid, false);
  assert.ok(blocked.findings.some((f) => f.code === 'app-localstorage'));
  assert.ok(blocked.errors.join(' ').includes('localStorage'));
  const linked = validateAppHtml('<a href="https://example.com/">x</a>');
  assert.equal(linked.valid, false);
  assert.ok(linked.findings.some((f) => f.code === 'app-external-host'));
});

// ---------------------------------------------------------------------------
// 3. buildAppCsp: merged directives
// ---------------------------------------------------------------------------

test('merge v098: buildAppCsp has frame-src (T6) and frame-ancestors (v0.97)', () => {
  const csp = buildAppCsp();
  assert.match(csp, /frame-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /connect-src 'none'/);
  const open = buildAppCsp({ allowedHosts: ['cdn.example.com'] });
  assert.match(open, /connect-src https:\/\/cdn\.example\.com/);
});
