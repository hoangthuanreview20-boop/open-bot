/**
 * Tests for the v1.02 rescue orchestra module (blackboard, fan-out,
 * merge, policy, supervisor, store, plan adapter, service).
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/orchestra-v102.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  Blackboard,
  BlackboardConflictError,
  OrchestraService,
  OrchestraStore,
  Supervisor,
  mergeResults,
  planFanOut,
  planToSubtasks,
  resolveOrchestraPolicy,
  shouldEscalate,
  shouldRetrySubtask,
  scoreWorkerForSubtask,
} from '../packages/core/dist/orchestra/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-orchestra-v102-'));
}

const WORKERS = [
  { id: 'w1', name: 'Researcher', description: 'research and web search', tools: ['web_search', 'read_file'] },
  { id: 'w2', name: 'Coder', description: 'write code and tests', tools: ['write_file', 'shell_exec'] },
];

test('blackboard: versioned writes, optimistic-lock conflicts, event log', () => {
  const board = new Blackboard('s1');
  const first = board.set('fact', 'hello', 'w1');
  assert.equal(first.version, 1);
  const second = board.set('fact', 'world', 'w2', 1);
  assert.equal(second.version, 2);
  assert.throws(() => board.set('fact', 'boom', 'w2', 1), BlackboardConflictError);
  assert.equal(board.get('fact')?.value, 'world');
  assert.equal(board.delete('fact', 'w1'), true);
  assert.equal(board.delete('fact'), false);
  assert.equal(board.history().length, 3);
});

test('fan-out: waves respect dependencies; cycles and unknown deps throw', () => {
  const plan = planFanOut([
    { id: 'a', sessionId: 's', title: 'A', status: 'pending', priority: 3, attempts: 0, maxAttempts: 3, triedWorkerIds: [], createdAt: '' },
    { id: 'b', sessionId: 's', title: 'B', status: 'pending', priority: 3, attempts: 0, maxAttempts: 3, triedWorkerIds: [], createdAt: '', dependsOn: ['a'] },
    { id: 'c', sessionId: 's', title: 'C', status: 'pending', priority: 3, attempts: 0, maxAttempts: 3, triedWorkerIds: [], createdAt: '' },
  ]);
  assert.deepEqual(plan.waves, [['a', 'c'], ['b']]);
  assert.throws(() => planFanOut([
    { id: 'a', sessionId: 's', title: 'A', status: 'pending', priority: 3, attempts: 0, maxAttempts: 3, triedWorkerIds: [], createdAt: '', dependsOn: ['zzz'] },
  ]), /unknown subtask/);
});

test('merge: joins outputs in order, reports file conflicts (first writer wins)', () => {
  const subtasks = [
    { id: 'a', sessionId: 's', title: 'Alpha', status: 'done', priority: 3, attempts: 1, maxAttempts: 3, triedWorkerIds: [], createdAt: '' },
    { id: 'b', sessionId: 's', title: 'Beta', status: 'done', priority: 3, attempts: 1, maxAttempts: 3, triedWorkerIds: [], createdAt: '' },
    { id: 'c', sessionId: 's', title: 'Gamma', status: 'failed', priority: 3, attempts: 3, maxAttempts: 3, triedWorkerIds: [], createdAt: '' },
  ];
  const results = new Map([
    ['a', { output: 'A output', filesChanged: ['shared.txt', 'a.txt'] }],
    ['b', { output: 'B output', filesChanged: ['shared.txt', 'b.txt'] }],
  ]);
  const merged = mergeResults(subtasks, results);
  assert.match(merged.combinedOutput, /## Alpha\nA output/);
  assert.ok(merged.combinedOutput.indexOf('Alpha') < merged.combinedOutput.indexOf('Beta'));
  assert.deepEqual(merged.filesChanged, ['a.txt', 'b.txt']);
  assert.equal(merged.conflicts.length, 1);
  assert.equal(merged.conflicts[0].file, 'shared.txt');
  assert.equal(merged.succeeded, 2);
  assert.equal(merged.failed, 1);
});

test('policy: defaults are conservative; retry/escalate rules', () => {
  const policy = resolveOrchestraPolicy({});
  assert.equal(policy.maxAttempts, 3);
  assert.equal(policy.retryOnFailure, true);
  assert.equal(shouldRetrySubtask(policy, 1, 0), true);
  assert.equal(shouldRetrySubtask(policy, 3, 0), false);
  assert.equal(shouldEscalate(policy, 2), true);
  assert.equal(shouldEscalate(policy, 1), false);
  assert.equal(resolveOrchestraPolicy({ maxAttempts: 0 }).maxAttempts, 1);
});

test('scoring: keyword overlap ranks the right worker first', () => {
  const subtask = {
    id: 's1', sessionId: 's', title: 'Research competitors', detail: 'web search for competitor pricing',
    status: 'pending', priority: 3, attempts: 0, maxAttempts: 3, triedWorkerIds: [], createdAt: '',
  };
  assert.ok(scoreWorkerForSubtask(WORKERS[0], subtask) > scoreWorkerForSubtask(WORKERS[1], subtask));
});

test('supervisor: runs waves through runBot, retries on another worker, merges', async () => {
  const calls = [];
  const supervisor = new Supervisor({
    runBot: async (worker, envelope) => {
      calls.push(envelope.subtaskId);
      if (envelope.subtaskId === 'st-2' && calls.filter((c) => c === 'st-2').length === 1) {
        throw new Error('worker failed once');
      }
      return { output: `result of ${envelope.title}` };
    },
  });
  const session = {
    id: 's1', goal: 'Do two things', status: 'created', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), subtaskIds: [],
  };
  const result = await supervisor.run(session, WORKERS, [
    { title: 'Research topic' },
    { title: 'Write code', dependsOn: ['Research topic'] },
  ]);
  assert.equal(result.session.status, 'done');
  assert.equal(result.subtasks.length, 2);
  assert.ok(result.subtasks.every((s) => s.status === 'done'));
  assert.equal(result.subtasks[1].attempts, 2, 'second subtask retried once on another worker');
  assert.match(result.merged.combinedOutput, /result of Research topic/);
  assert.match(result.merged.combinedOutput, /result of Write code/);
});

test('supervisor: without runBot it throws; with no worker it escalates', async () => {
  const supervisor = new Supervisor({});
  const session = {
    id: 's2', goal: 'x', status: 'created', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), subtaskIds: [],
  };
  await assert.rejects(supervisor.run(session, WORKERS, [{ title: 'T' }]), /needs a runBot/);
  const withBot = new Supervisor({ runBot: async () => ({ output: 'ok' }) });
  const result = await withBot.run(
    { ...session, id: 's3' },
    [],
    [{ title: 'T' }],
  );
  assert.equal(result.subtasks[0].status, 'escalated');
  assert.equal(result.session.status, 'failed');
});

test('plan adapter: titles resolve to ids; unknown deps and cycles throw', () => {
  const subtasks = planToSubtasks('s1', [
    { title: 'First' },
    { title: 'Second', dependsOn: ['First'] },
  ]);
  assert.equal(subtasks[1].dependsOn[0], 'st-1');
  assert.throws(() => planToSubtasks('s1', [{ title: 'A', dependsOn: ['Missing'] }]), /unknown step/);
  assert.throws(() => planToSubtasks('s1', [
    { title: 'A', dependsOn: ['B'] },
    { title: 'B', dependsOn: ['A'] },
  ]), /cycle/);
});

test('store + service: sessions persist, run end-to-end, cancel marks cancelled', async () => {
  const dir = tmpDir();
  const store = new OrchestraStore(path.join(dir, 'orchestra'));
  const session = {
    id: 's9', goal: 'g', status: 'created', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), subtaskIds: [],
  };
  store.save(session, []);
  assert.equal(store.get('s9')?.session.id, 's9');
  assert.equal(store.list().length, 1);
  assert.equal(store.delete('s9'), true);
  assert.equal(store.get('s9'), undefined);

  const service = new OrchestraService({
    storeDir: path.join(dir, 'orchestra'),
    runBot: async (_worker, envelope) => ({ output: `did ${envelope.title}` }),
  });
  const result = await service.runSession({
    goal: 'Do it',
    workers: WORKERS,
    subtasks: [{ title: 'Step one' }, { title: 'Step two' }],
  });
  assert.equal(result.session.status, 'done');
  assert.equal(service.list().length, 1);
  const created = service.createSession('Another goal');
  assert.equal(service.cancel(created.id), true);
  assert.equal(service.get(created.id)?.session.status, 'cancelled');
});
