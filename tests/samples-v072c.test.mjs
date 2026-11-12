/**
 * Tests for v0.72c (Team C): sample routines, sample automations and the
 * example team config (packages/core/src + docs/team.example.json).
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/samples-v072c.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SAMPLE_ROUTINES, sampleRoutines } from '../packages/core/dist/agent/routines.js';
import {
  SAMPLE_AUTOMATIONS,
  sampleAutomations,
  validateAutomation,
} from '../packages/core/dist/automations/index.js';
import { loadTeamConfig } from '../packages/core/dist/team/team.js';

const EXAMPLE_TEAM_PATH = fileURLToPath(new URL('../docs/team.example.json', import.meta.url));

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-samples-v072c-test-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (a) Sample routines
// ---------------------------------------------------------------------------

test('SAMPLE_ROUTINES: 5 routines, unique ids, positive intervals, non-empty prompts', () => {
  assert.equal(SAMPLE_ROUTINES.length, 5);
  const ids = SAMPLE_ROUTINES.map((r) => r.id);
  assert.deepEqual(
    [...ids].sort(),
    ['backup-reminder', 'code-health', 'inbox-check', 'morning-brief', 'weekly-report'],
  );
  assert.equal(new Set(ids).size, ids.length, 'routine ids must be unique');
  for (const r of SAMPLE_ROUTINES) {
    assert.equal(typeof r.name, 'string');
    assert.ok(r.name.trim().length > 0, `${r.id} needs a name`);
    assert.equal(typeof r.prompt, 'string');
    assert.ok(r.prompt.trim().length > 0, `${r.id} needs a non-empty prompt`);
    assert.ok(Number.isFinite(r.cronMinutes) && r.cronMinutes > 0, `${r.id} needs cronMinutes > 0`);
    assert.equal(r.enabled, true);
    assert.equal(r.botId, '', `${r.id} must leave botId empty for the user to assign`);
  }
  assert.equal(
    SAMPLE_ROUTINES.find((r) => r.id === 'morning-brief').cronMinutes,
    480,
  );
  assert.equal(
    SAMPLE_ROUTINES.find((r) => r.id === 'inbox-check').cronMinutes,
    30,
  );
  assert.equal(
    SAMPLE_ROUTINES.find((r) => r.id === 'weekly-report').cronMinutes,
    10080,
  );
  assert.equal(
    SAMPLE_ROUTINES.find((r) => r.id === 'backup-reminder').cronMinutes,
    1440,
  );
  assert.equal(
    SAMPLE_ROUTINES.find((r) => r.id === 'code-health').cronMinutes,
    10080,
  );
});

test('sampleRoutines() returns a fresh copy: mutating it leaves the samples untouched', () => {
  const first = sampleRoutines();
  assert.equal(first.length, 5);
  first[0].name = 'MUTATED';
  first[0].cronMinutes = 1;
  first[0].prompt = '';
  first.push({
    id: 'extra',
    botId: '',
    name: 'Extra',
    prompt: 'x',
    cronMinutes: 1,
    enabled: true,
  });

  const second = sampleRoutines();
  assert.equal(second.length, 5);
  assert.equal(second[0].name, SAMPLE_ROUTINES[0].name);
  assert.equal(second[0].cronMinutes, SAMPLE_ROUTINES[0].cronMinutes);
  assert.equal(second[0].prompt, SAMPLE_ROUTINES[0].prompt);
  assert.equal(SAMPLE_ROUTINES[0].name, 'Morning brief');
  assert.equal(SAMPLE_ROUTINES.length, 5);
});

// ---------------------------------------------------------------------------
// (b) Sample automations
// ---------------------------------------------------------------------------

test('SAMPLE_AUTOMATIONS: 4 automations, valid shape, no webhook trigger', () => {
  assert.equal(SAMPLE_AUTOMATIONS.length, 4);
  const ids = SAMPLE_AUTOMATIONS.map((a) => a.id);
  assert.deepEqual(
    [...ids].sort(),
    ['agent-done-notify', 'morning-brief-auto', 'notes-changed-index', 'weekly-report-auto'],
  );
  assert.equal(new Set(ids).size, ids.length, 'automation ids must be unique');

  const triggerKinds = new Set(['interval', 'cron', 'event', 'manual', 'webhook']);
  const actionKinds = new Set(['run-agent', 'run-tool', 'create-task', 'notify']);
  for (const a of SAMPLE_AUTOMATIONS) {
    assert.ok(a.name.trim().length > 0, `${a.id} needs a name`);
    assert.equal(a.enabled, true);
    assert.ok(triggerKinds.has(a.trigger.kind), `${a.id}: unknown trigger kind`);
    assert.notEqual(a.trigger.kind, 'webhook', `${a.id} must not use a webhook trigger`);
    assert.ok(actionKinds.has(a.action.kind), `${a.id}: unknown action kind`);
    // The real validator from engine.ts must accept every sample.
    assert.deepEqual(validateAutomation(a), [], `${a.id} must validate: ${validateAutomation(a)}`);
  }

  const morning = SAMPLE_AUTOMATIONS.find((a) => a.id === 'morning-brief-auto');
  assert.equal(morning.trigger.kind, 'interval');
  assert.equal(morning.trigger.minutes, 480);
  assert.equal(morning.action.kind, 'run-agent');
  assert.equal(morning.action.botId, '');

  const weekly = SAMPLE_AUTOMATIONS.find((a) => a.id === 'weekly-report-auto');
  assert.equal(weekly.trigger.kind, 'cron');
  assert.equal(weekly.trigger.expression, '0 9 * * 1');
  assert.equal(weekly.action.kind, 'run-agent');

  const notes = SAMPLE_AUTOMATIONS.find((a) => a.id === 'notes-changed-index');
  assert.equal(notes.trigger.kind, 'event');
  assert.equal(notes.trigger.event, 'file-changed');
  assert.equal(notes.trigger.pathPattern, 'notes/*.md');
  assert.equal(notes.action.kind, 'run-agent');

  const notify = SAMPLE_AUTOMATIONS.find((a) => a.id === 'agent-done-notify');
  assert.equal(notify.trigger.kind, 'event');
  assert.equal(notify.trigger.event, 'agent-done');
  assert.equal(notify.action.kind, 'notify');
  assert.ok(notify.action.message.trim().length > 0);
});

test('sampleAutomations() returns a fresh deep copy: nested mutation leaves the samples untouched', () => {
  const first = sampleAutomations();
  assert.equal(first.length, 4);
  first[0].trigger.minutes = 1;
  first[0].action.prompt = 'MUTATED';
  first[0].name = 'MUTATED';
  first.push({
    id: 'extra',
    botId: '',
    name: 'Extra',
    trigger: { kind: 'manual' },
    action: { kind: 'notify', message: 'x' },
    enabled: true,
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:00.000Z',
  });

  const second = sampleAutomations();
  assert.equal(second.length, 4);
  assert.equal(second[0].trigger.minutes, 480);
  assert.ok(second[0].action.prompt.includes('morning news'));
  assert.equal(second[0].name, 'Morning brief (auto)');
  assert.equal(SAMPLE_AUTOMATIONS[0].trigger.minutes, 480);
  assert.equal(SAMPLE_AUTOMATIONS.length, 4);
  assert.deepEqual(validateAutomation(second[0]), []);
});

// ---------------------------------------------------------------------------
// (c) Example team config
// ---------------------------------------------------------------------------

test('docs/team.example.json parses and loadTeamConfig reads it from a temp dir', () => {
  const text = fs.readFileSync(EXAMPLE_TEAM_PATH, 'utf8');
  const parsed = JSON.parse(text);
  assert.equal(parsed.id, 'team-example');
  assert.equal(parsed.name, 'Example Team');

  // loadTeamConfig reads <dir>/team.json, so copy the example there.
  const dir = makeTempDir();
  fs.copyFileSync(EXAMPLE_TEAM_PATH, path.join(dir, 'team.json'));

  const team = loadTeamConfig(dir);
  assert.equal(team.id, 'team-example');
  assert.equal(team.name, 'Example Team');
  assert.equal(team.members.length, 2);
  assert.deepEqual(
    team.members.map((m) => [m.userId, m.role]),
    [
      ['owner', 'admin'],
      ['teammate', 'member'],
    ],
  );
  assert.equal(team.sharedBots.length, 1);
  assert.equal(team.sharedBots[0].botId, 'shared-assistant');
  assert.equal(team.sharedBots[0].sharedBy, 'owner');
  // No secret or real machine path anywhere in the example.
  assert.ok(!text.includes('sk-') && !text.includes('api_key') && !text.includes('/home/'));
  assert.ok(!text.includes('C:\\'));
});
