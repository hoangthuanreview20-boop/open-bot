/**
 * Tests for whole-settings validation (v1.01):
 * `packages/core/src/hooks/settingsValidation.ts` + the headless CLI
 * (`open-bot hooks validate`).
 *
 * Under test:
 * - `validateHookSettings`: valid object / bare array / bad commands
 *   type / invalid entry (field paths) / duplicate names / bad gate.
 * - `validateHookSettingsFiles`: missing files = valid; broken JSON =
 *   reported; invalid entries in real files = reported with fields.
 * - CLI: `hooks validate` exit 0 on a clean dir, exit 1 with the list
 *   of issues on a dirty dir, `--json` machine-readable.
 *
 * Run after building core + cli:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/cli
 *   node --test tests/hooks-settings-validation-v101.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  validateHookCommandsList,
  validateHookSettings,
  validateHookSettingsFiles,
  validateTestGateInput,
} from '../packages/core/dist/hooks/index.js';

test('validateHookSettings: valid object and bare array pass', () => {
  assert.deepEqual(
    validateHookSettings({
      commands: [{ name: 'a', command: 'true', events: ['PreToolUse'] }],
      testGate: { command: 'npm test' },
    }),
    [],
  );
  assert.deepEqual(
    validateHookSettings([{ name: 'a', command: 'true', events: ['PreToolUse'] }]),
    [],
  );
  assert.deepEqual(validateHookSettings({}), []);
  assert.deepEqual(validateHookSettings({ testGate: {} }), [], 'empty gate object = unconfigured, not an error here');
});

test('validateHookSettings: non-object input is reported', () => {
  const issues = validateHookSettings('nope');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field, 'settings');
  assert.deepEqual(validateHookSettings(null)[0].field, 'settings');
});

test('validateHookSettings: commands must be an array', () => {
  const issues = validateHookSettings({ commands: 'true' });
  assert.ok(issues.some((i) => i.field === 'commands'));
});

test('validateHookSettings: invalid entries carry index + field paths', () => {
  const issues = validateHookSettings({
    commands: [
      { name: 'ok', command: 'true', events: ['PreToolUse'] },
      { name: 'Bad Name!', command: '', events: [] },
      { name: 'also-bad', command: 'true', events: ['Nope'] },
    ],
  });
  assert.ok(issues.some((i) => i.field === 'commands[1].name'));
  assert.ok(issues.some((i) => i.field === 'commands[1].command'));
  assert.ok(issues.some((i) => i.field === 'commands[2].events'));
  assert.ok(!issues.some((i) => i.field.startsWith('commands[0]')), 'valid entry is silent');
});

test('validateHookSettings: duplicate hook names are reported', () => {
  const issues = validateHookSettings({
    commands: [
      { name: 'dup', command: 'true', events: ['PreToolUse'] },
      { name: 'dup', command: 'false', events: ['Stop'] },
    ],
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field, 'commands[1].name');
  assert.match(issues[0].message, /trùng/);
});

test('validateHookSettings: bad testGate is reported', () => {
  const issues = validateHookSettings({ testGate: { commands: ['  '] } });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field, 'testGate');
  assert.deepEqual(validateHookSettings({ testGate: { commands: ['npm test'] } }), []);
});

test('validateHookCommandsList / validateTestGateInput: direct helpers', () => {
  assert.deepEqual(validateHookCommandsList([]), []);
  assert.deepEqual(validateTestGateInput(null), []);
  assert.deepEqual(validateTestGateInput(undefined), []);
  assert.equal(validateTestGateInput({ command: '' }).length, 1);
  assert.deepEqual(validateTestGateInput({ command: 'npm test' }), []);
});

// ---------------------------------------------------------------------------
// validateHookSettingsFiles + CLI
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const cli = path.join(repo, 'apps', 'cli', 'dist', 'cli.js');

const cliDirs = [];
function makeCliDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-hooks-validate-v101-'));
  cliDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of cliDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function runCli(args, dataDir) {
  return spawnSync(process.execPath, [cli, ...args, '--data-dir', dataDir], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, OPENBOT_DATA_DIR: dataDir },
  });
}

test('validateHookSettingsFiles: missing files = no issues', () => {
  assert.deepEqual(validateHookSettingsFiles(makeCliDir()), []);
});

test('validateHookSettingsFiles: broken JSON and bad entries are reported', () => {
  const dir = makeCliDir();
  fs.writeFileSync(path.join(dir, 'hooks-commands.json'), '{ not json', 'utf8');
  fs.writeFileSync(
    path.join(dir, 'hooks-test-gate.json'),
    JSON.stringify({ commands: [] }),
    'utf8',
  );
  const issues = validateHookSettingsFiles(dir);
  assert.ok(issues.some((i) => i.field === 'commands'));
  assert.ok(issues.some((i) => i.field === 'testGate'));
});

test('validateHookSettingsFiles: valid files pass', () => {
  const dir = makeCliDir();
  fs.writeFileSync(
    path.join(dir, 'hooks-commands.json'),
    JSON.stringify([{ name: 'a', command: 'true', events: ['PreToolUse'] }]),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'hooks-test-gate.json'),
    JSON.stringify({ commands: ['npm test'] }),
    'utf8',
  );
  assert.deepEqual(validateHookSettingsFiles(dir), []);
});

test('cli hooks validate: clean dir → exit 0; dirty dir → exit 1 with issues', () => {
  const clean = makeCliDir();
  const resClean = runCli(['hooks', 'validate'], clean);
  assert.equal(resClean.status, 0);
  assert.match(resClean.stdout, /hợp lệ/);

  const dirty = makeCliDir();
  fs.writeFileSync(
    path.join(dirty, 'hooks-commands.json'),
    JSON.stringify([
      { name: 'a', command: 'true', events: ['PreToolUse'] },
      { name: 'a', command: 'true', events: ['Stop'] },
      { name: 'Bad!', command: '', events: [] },
    ]),
    'utf8',
  );
  const res = runCli(['hooks', 'validate'], dirty);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /4 lỗi/);
  assert.match(res.stdout, /commands\[1\]\.name/);
  assert.match(res.stdout, /commands\[2\]/);

  const json = runCli(['hooks', 'validate', '--json'], dirty);
  assert.equal(json.status, 1);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.valid, false);
  assert.equal(parsed.issues.length, 4);
});

test('cli hooks log --summary: totals + per-hook rows', () => {
  const dir = makeCliDir();
  fs.writeFileSync(
    path.join(dir, 'hook-executions.jsonl'),
    [
      { seq: 1, at: '2026-11-14T00:00:01.000Z', hookName: 'a', event: 'PreToolUse', action: 'allow', durationMs: 10, timedOut: false },
      { seq: 2, at: '2026-11-14T00:00:02.000Z', hookName: 'a', event: 'PreToolUse', action: 'block', durationMs: 30, timedOut: false },
      { seq: 3, at: '2026-11-14T00:00:03.000Z', hookName: 'b', event: 'SubagentStop', action: 'error', durationMs: 50, timedOut: true },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
    'utf8',
  );
  const res = runCli(['hooks', 'log', '--summary'], dir);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Tổng: 3 lần chạy · 1 block · 1 lỗi · 1 timeout/);
  assert.match(res.stdout, /a  2 lần · 1 block/);
  assert.match(res.stdout, /b  1 lần · 0 block · 1 lỗi · 1 timeout/);

  const json = runCli(['hooks', 'log', '--summary', '--json'], dir);
  assert.equal(json.status, 0);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.totals.total, 3);
  assert.equal(parsed.perHook[0].hookName, 'a');
  assert.equal(parsed.perHook[0].avgDurationMs, 20);

  const empty = runCli(['hooks', 'log', '--summary'], makeCliDir());
  assert.equal(empty.status, 0);
  assert.match(empty.stdout, /Chưa có lần hook chạy nào/);
});
