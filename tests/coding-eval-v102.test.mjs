/**
 * coding-eval-v102.test.mjs — eval harness for the coding agent (v1.02, Team T4).
 * Sample tasks pass end-to-end through the real loop; a deliberately
 * failing task scores FAIL; the Markdown report reflects both.
 * Run: node --test tests/coding-eval-v102.test.mjs (after building core)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  describeEvalCheck,
  renderEvalReportMarkdown,
  runEval,
  sampleEvalTasks,
  scoreCheck,
} from '../packages/core/dist/coding/eval.js';
import { Workspace } from '../packages/core/dist/coding/workspace.js';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-eval-v102-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('eval: scoreCheck covers all file check kinds', (t) => {
  const dir = tmpDir(t);
  const ws = new Workspace(dir);
  ws.write('a.txt', 'hello world\n');
  assert.equal(scoreCheck({ kind: 'file-exists', path: 'a.txt' }, ws).passed, true);
  assert.equal(scoreCheck({ kind: 'file-exists', path: 'nope.txt' }, ws).passed, false);
  assert.equal(scoreCheck({ kind: 'file-not-exists', path: 'nope.txt' }, ws).passed, true);
  assert.equal(scoreCheck({ kind: 'file-contains', path: 'a.txt', text: 'world' }, ws).passed, true);
  assert.equal(scoreCheck({ kind: 'file-contains', path: 'a.txt', text: 'mars' }, ws).passed, false);
  assert.equal(scoreCheck({ kind: 'file-not-contains', path: 'a.txt', text: 'mars' }, ws).passed, true);
  assert.equal(scoreCheck({ kind: 'file-not-contains', path: 'a.txt', text: 'world' }, ws).passed, false);
  assert.equal(scoreCheck({ kind: 'file-contains', path: 'missing.txt', text: 'x' }, ws).passed, false);
  assert.equal(describeEvalCheck({ kind: 'command', argv: ['node', '--version'] }), 'command exits 0: node --version');
});

test('eval: sample tasks all pass through the real loop', async (t) => {
  const dir = tmpDir(t);
  const report = await runEval(sampleEvalTasks(), { workspacesDir: dir, keepWorkspaces: false });
  assert.equal(report.tasks.length, 3);
  assert.equal(report.passedTasks, 3);
  assert.equal(report.failedTasks, 0);
  assert.equal(report.stats.successRate, 1);
  assert.ok(report.stats.avgSteps > 0);
  for (const task of report.tasks) {
    assert.equal(task.passed, true);
    assert.equal(task.run.status, 'succeeded');
    assert.ok(task.checks.every((c) => c.passed));
  }
  const md = renderEvalReportMarkdown(report);
  assert.match(md, /3\/3 passed/);
  assert.match(md, /PASS — Create a greeting module/);
  assert.match(md, /PASS — Fix a typo and verify/);
  assert.match(md, /PASS — Remove a dead file/);
});

test('eval: a task whose checks fail scores FAIL and explains why', async (t) => {
  const dir = tmpDir(t);
  const report = await runEval([
    {
      id: 'deliberate-fail',
      title: 'Deliberately wrong edit',
      task: 'Create a file that says goodbye.',
      script: [
        { thought: 'creating', action: { kind: 'create_file', path: 'x.txt', content: 'goodbye\n' } },
        { thought: 'done', action: { kind: 'finish', summary: 'Created x.txt.', success: true } },
      ],
      checks: [{ kind: 'file-contains', path: 'x.txt', text: 'hello' }],
    },
  ], { workspacesDir: dir });
  assert.equal(report.passedTasks, 0);
  assert.equal(report.failedTasks, 1);
  assert.equal(report.tasks[0].passed, false);
  assert.equal(report.tasks[0].checks[0].passed, false);
  assert.equal(report.stats.failureReasons['check failed'], 1);
  assert.match(renderEvalReportMarkdown(report), /FAIL — Deliberately wrong edit/);
});

test('eval: command checks run sandboxed and score exit codes', async (t) => {
  const dir = tmpDir(t);
  const report = await runEval([
    {
      id: 'command-check',
      title: 'Command check task',
      task: 'Create x.txt.',
      script: [
        { thought: 'creating', action: { kind: 'create_file', path: 'x.txt', content: 'x\n' } },
        { thought: 'done', action: { kind: 'finish', summary: 'ok', success: true } },
      ],
      checks: [
        { kind: 'command', argv: ['node', '-e', 'process.exit(0)'] },
        { kind: 'command', argv: ['node', '-e', 'process.exit(2)'], expectExitCode: 2 },
      ],
    },
  ], { workspacesDir: dir });
  assert.equal(report.passedTasks, 1);
  assert.ok(report.tasks[0].checks.every((c) => c.passed));
});
