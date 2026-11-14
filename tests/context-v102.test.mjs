/**
 * Tests for the v1.02 rescue context module (estimator, budget,
 * pruning, cache hints, compaction history, lead agent, long task,
 * checkpoints, virtual computer, long-run compaction).
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/context-v102.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CompactionHistory,
  LeadAgent,
  LongRunCompaction,
  LongTask,
  PromptCacheTracker,
  TaskCheckpointStore,
  VirtualComputer,
  buildExtractiveSummary,
  cacheSupportForProvider,
  effectiveContextLimit,
  estimateTokens,
  inferContextLimitFromModelName,
  isSmallContextModel,
  measureContextBudget,
  pruneLowRelevanceTurns,
} from '../packages/core/dist/context/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-context-v102-'));
}

test('estimator: chars/4 heuristic, known model limits, small-context detection', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcdefgh'), 2);
  assert.ok(inferContextLimitFromModelName('gemini-2.5-flash') >= 1_000_000);
  assert.equal(inferContextLimitFromModelName('some-unknown-model-xyz'), 128_000);
  assert.equal(isSmallContextModel('gpt-3.5-turbo'), true);
  assert.equal(isSmallContextModel('gemini-2.5-flash'), false);
  assert.equal(effectiveContextLimit('gpt-4o', 5000), 5000);
});

test('budget: measures usage, reports overflow, formats a summary', () => {
  const snapshot = measureContextBudget({
    model: 'gpt-3.5-turbo',
    systemPrompt: 'You are helpful.',
    messages: [
      { role: 'user', content: 'Hello, please help me with this task.' },
      { role: 'assistant', content: 'Sure, what do you need?' },
    ],
    tools: [{ name: 'read_file', description: 'Read a file.' }],
  });
  assert.ok(snapshot.limit > 0);
  assert.ok(snapshot.usedTokens > 0);
  assert.equal(snapshot.fits, true);
  assert.equal(snapshot.overflowTokens, 0);
  assert.ok(snapshot.breakdown.systemTokens > 0);
  assert.ok(snapshot.breakdown.messageTokens > 0);
  assert.ok(snapshot.breakdown.toolTokens > 0);
  assert.match(snapshot.usageRatio.toString(), /0\./);

  const over = measureContextBudget({
    model: 'gpt-3.5-turbo',
    messages: [{ role: 'user', content: 'x'.repeat(200_000) }],
  });
  assert.equal(over.fits, false);
  assert.ok(over.overflowTokens > 0);
});

test('pruning: drops low-relevance turns, keeps recent + pinned, summarizes the dropped', () => {
  const messages = [
    { role: 'user', content: 'Explain quantum computing in detail please.' },
    { role: 'assistant', content: 'Quantum computing uses qubits and superposition to compute.' },
    { role: 'user', content: 'What is the weather today?' },
    { role: 'assistant', content: 'It is sunny and warm outside today.' },
    { role: 'user', content: 'Tell me more about quantum entanglement.' },
    { role: 'assistant', content: 'Entanglement links qubits across distance.' },
  ];
  const result = pruneLowRelevanceTurns(messages, 20, { latestUserText: 'quantum entanglement' });
  assert.ok(result.kept.length < messages.length || result.freedTokens === 0);
  assert.ok(result.kept.length >= 4, 'recent turns are kept');
  assert.equal(result.kept[result.kept.length - 1].content, 'Entanglement links qubits across distance.');
  const summary = buildExtractiveSummary(result.dropped, 'quantum');
  assert.equal(typeof summary, 'string');
});

test('cache hints: provider support + tracker hit rate and prefix sizes', () => {
  assert.equal(cacheSupportForProvider('anthropic'), true);
  assert.equal(cacheSupportForProvider('ollama'), false);
  const tracker = new PromptCacheTracker();
  assert.equal(tracker.hitRate(), null);
  tracker.record({ model: 'claude-sonnet-4', prefixTokens: 1000, totalTokens: 2000, hit: true });
  tracker.record({ model: 'claude-sonnet-4', prefixTokens: 1200, totalTokens: 2400, hit: false });
  assert.equal(tracker.hitRate(), 0.5);
  assert.equal(tracker.medianPrefixTokens(), 1200);
  assert.equal(tracker.maxPrefixTokens(), 1200);
});

test('compaction history: records persist to disk and list newest first', () => {
  const dir = tmpDir();
  const history = new CompactionHistory(path.join(dir, 'compactions.json'));
  history.add({
    id: 'c1', at: new Date().toISOString(), tokensBefore: 10000, tokensAfter: 2000,
    turnsDropped: 5, summaryChars: 100, reason: 'budget',
  });
  assert.equal(history.size, 1);
  const reloaded = new CompactionHistory(path.join(dir, 'compactions.json'));
  assert.equal(reloaded.size, 1);
  assert.equal(reloaded.list()[0].id, 'c1');
});

test('lead agent: plans waves topologically, runs delegates, collects results', async () => {
  const agent = new LeadAgent(async (subtask) => `done: ${subtask.title}`);
  const waves = LeadAgent.planWaves([
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B', dependsOn: ['a'] },
    { id: 'c', title: 'C' },
  ]);
  assert.deepEqual(waves.map((w) => w.map((s) => s.id)), [['a', 'c'], ['b']]);
  assert.throws(() => LeadAgent.planWaves([
    { id: 'a', title: 'A', dependsOn: ['b'] },
    { id: 'b', title: 'B', dependsOn: ['a'] },
  ]), /cycle/);
  const result = await agent.run([
    { id: 'a', title: 'First' },
    { id: 'b', title: 'Second', dependsOn: ['a'] },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 2);
  assert.match(result.combinedOutput, /done: First/);
});

test('long task: state machine, progress, staleness, snapshot restore', () => {
  const task = new LongTask('t1', 'Big refactor', 4);
  assert.equal(task.status, 'created');
  assert.equal(task.progress, 0);
  task.start();
  task.advance('step one');
  task.advance('step two');
  assert.equal(task.progress, 0.5);
  assert.equal(task.isStale(Date.now()), false);
  assert.equal(task.isStale(Date.now() + 10 * 60 * 1000), true);
  task.complete('all done');
  assert.equal(task.status, 'done');
  assert.equal(task.progress, 1);
  assert.throws(() => task.start(), /cannot start/);
  const restored = LongTask.fromSnapshot(task.state);
  assert.equal(restored.status, 'done');
});

test('task checkpoints: save/list/latest round-trip per task', () => {
  const dir = tmpDir();
  const store = new TaskCheckpointStore({ dir });
  const task = new LongTask('t1', 'Job', 2);
  task.start();
  const saved = store.save('t1', task.state, 'half done');
  assert.equal(saved.seq, 1);
  assert.equal(store.latest('t1')?.summary, 'half done');
  assert.equal(store.list('t1').length, 1);
  assert.equal(store.latest('missing'), undefined);
  store.clear('t1');
  assert.equal(store.list('t1').length, 0);
});

test('virtual computer: scoped files, path escape rejected, command runs in root', async () => {
  const dir = tmpDir();
  const computer = new VirtualComputer({ root: path.join(dir, 'vc') });
  computer.writeFile('notes/hello.txt', 'hello');
  assert.equal(computer.readFile('notes/hello.txt'), 'hello');
  assert.deepEqual(computer.listFiles(), ['notes/hello.txt']);
  assert.ok(computer.sizeBytes() > 0);
  assert.throws(() => computer.resolve('../escape.txt'), /escapes/);
  const result = await computer.runCommand(['node', '-e', "console.log('hi')"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /hi/);
  const failing = await computer.runCommand(['node', '-e', 'process.exit(3)']);
  assert.equal(failing.exitCode, 3);
});

test('long-run compaction: compacts over the trigger ratio, records history', () => {
  const dir = tmpDir();
  const history = new CompactionHistory(path.join(dir, 'compactions.json'));
  const compaction = new LongRunCompaction({ triggerRatio: 0.2, history });
  const messages = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Turn ${i} about databases and indexes and query plans. `.repeat(20),
  }));
  const result = compaction.check({
    model: 'gpt-3.5-turbo',
    messages,
    latestUserText: 'databases',
  });
  assert.equal(result.compacted, true);
  assert.ok(result.turnsDropped > 0);
  assert.ok(result.tokensFreed > 0);
  assert.equal(history.size, 1);
  // Under the trigger ratio: no compaction.
  const calm = compaction.check({
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(calm.compacted, false);
});
