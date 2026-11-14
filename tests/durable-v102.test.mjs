/**
 * Tests for the v1.02 rescue durable + observability modules
 * (journal, session, recovery, resume, cost, OTel, trace query).
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/durable-v102.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ActiveRunRegistry,
  DurableRunner,
  DurableSession,
  OtelExporter,
  RunJournal,
  TraceQuery,
  detectInterruptedRuns,
  estimateCostDetailed,
  formatUsd,
  isKnownModel,
  isLocalModel,
  listRecoveryCandidates,
  readOtelTraces,
  resumeRunFromJournal,
  scanResumableRuns,
  traceToOtel,
} from '../packages/core/dist/index.js';
import { TraceStore } from '../packages/core/dist/tracing/store.js';
import { Tracer } from '../packages/core/dist/tracing/tracer.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-durable-v102-'));
}

test('journal: records entries with monotonic seq, refuses duplicate keys, replays state', () => {
  const dir = tmpDir();
  const journal = new RunJournal('run-1', dir);
  assert.equal(journal.record('run_started', { botId: 'b1' }), true);
  assert.equal(journal.recordStepStarted(0, 'first step'), true);
  assert.equal(journal.recordStepStarted(0, 'first step again'), false, 'duplicate key refused');
  assert.equal(journal.recordStepCompleted(0), true);
  assert.equal(journal.recordToolCall('c1', 'read_file'), true);
  assert.equal(journal.recordToolResult('c1', 'read_file', 'contents'), true);
  journal.checkpoint({ messages: [{ role: 'user', content: 'hi' }], completedToolCalls: [], tokensUsed: 42, nextStepIndex: 1 });
  journal.finish('done');
  assert.equal(journal.isFinished, true);

  const replay = RunJournal.replayEntries(journal.filePath);
  assert.equal(replay.finished, true);
  assert.ok(replay.lastCheckpoint);
  assert.equal(replay.lastCheckpoint.tokensUsed, 42);
  const verification = RunJournal.verifyJournal(journal.filePath);
  assert.equal(verification.ok, true);
  assert.equal(verification.hasCheckpoint, true);
  assert.equal(verification.finished, true);
});

test('journal: corrupt lines are skipped on read; prune keeps unfinished runs', () => {
  const dir = tmpDir();
  const done = new RunJournal('run-done', dir);
  done.record('run_started', {});
  done.finish('ok');
  const open = new RunJournal('run-open', dir);
  open.record('run_started', {});
  open.checkpoint({ messages: [], completedToolCalls: [], tokensUsed: 0, nextStepIndex: 0 });
  fs.appendFileSync(open.filePath, 'this is not json\n{"seq": 999}\n');
  const verification = RunJournal.verifyJournal(open.filePath);
  assert.equal(verification.badLines, 1);
  const pruned = RunJournal.pruneJournals(dir, 0);
  assert.ok(pruned.deleted.includes('run-done.journal.jsonl'));
  assert.ok(pruned.kept.includes('run-open.journal.jsonl'), 'unfinished runs are never pruned');
});

test('session + recovery: start/heartbeat/finish; abandoned run is a recovery candidate', () => {
  const dir = tmpDir();
  const journals = path.join(dir, 'run-journals');
  const registryFile = path.join(dir, 'active-runs.json');
  const session = new DurableSession({
    runId: 'run-2', botId: 'b1', journalDir: journals, registryFile, heartbeatMs: 50,
  });
  session.start();
  session.checkpoint({ messages: [], completedToolCalls: [], tokensUsed: 10, nextStepIndex: 1 });
  session.abandon(); // simulate a crash: no run_finished, heartbeat stops
  const registry = new ActiveRunRegistry(registryFile);
  assert.equal(registry.list().length, 1);
  // A stale heartbeat (old) + unfinished journal = interrupted.
  const stale = detectInterruptedRuns(registry, journals, Date.now() + 120_000);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].runId, 'run-2');
  const resumable = scanResumableRuns(journals);
  assert.equal(resumable.length, 1);
  const candidates = listRecoveryCandidates(registry, journals, Date.now() + 120_000);
  assert.equal(candidates.length, 1);

  // A finished run is not a candidate.
  const finished = new DurableSession({ runId: 'run-3', journalDir: journals, registryFile });
  finished.start();
  finished.finish('ok');
  assert.equal(listRecoveryCandidates(new ActiveRunRegistry(registryFile), journals, Date.now() + 120_000).length, 1);
});

test('resume: rebuilds state from the journal; DurableRunner never re-executes a finished step', async () => {
  const dir = tmpDir();
  const journal = new RunJournal('run-4', dir);
  journal.record('run_started', {});
  journal.recordStepCompleted(0);
  journal.recordToolCall('c1', 'read_file');
  journal.recordToolResult('c1', 'read_file', 'old result');
  journal.checkpoint({
    messages: [{ role: 'user', content: 'hi' }],
    completedToolCalls: [{ call: { id: 'c1' }, result: 'old result' }],
    tokensUsed: 5,
    nextStepIndex: 1,
  });
  const state = resumeRunFromJournal(journal.filePath, 'run-4');
  assert.ok(state);
  assert.equal(state.nextStepIndex, 1);
  assert.equal(state.tokensUsed, 5);
  assert.equal(state.messages.length, 1);

  const journal2 = new RunJournal('run-4', dir);
  const runner = new DurableRunner(journal2, state);
  let executions = 0;
  const step0 = await runner.runStep(0, async () => { executions++; return 'x'; });
  assert.equal(step0.executed, false, 'step 0 was already done');
  const step1 = await runner.runStep(1, async () => { executions++; return 'y'; });
  assert.equal(step1.executed, true);
  assert.equal(executions, 1);
  const tool = await runner.runToolCall('c1', 'read_file', async () => 'new result');
  assert.equal(tool.executed, false, 'tool c1 was already done');
  assert.equal(tool.result, 'old result');
});

test('observability cost: known model priced, local model $0, unknown model null', () => {
  const known = estimateCostDetailed('gpt-4o', 1000, 500);
  assert.equal(known.known, true);
  assert.ok(typeof known.costUsd === 'number' && known.costUsd > 0);
  const local = estimateCostDetailed('local:llama', 1000, 500);
  assert.equal(local.costUsd, 0);
  assert.equal(local.local, true);
  const unknown = estimateCostDetailed('no-such-model-xyz', 1000, 500);
  assert.equal(unknown.costUsd, null);
  assert.equal(unknown.known, false);
  assert.equal(isLocalModel('ollama:llama3'), true);
  assert.equal(isKnownModel('gpt-4o'), true);
  assert.match(formatUsd(0.001234), /^\$0\.0012/);
});

test('observability otel + query: trace converts to OTel, exporter round-trips, queries aggregate', () => {
  const dir = tmpDir();
  const tracer = new Tracer({ runId: 'r1', botId: 'b1', now: () => 1000 });
  const span = tracer.startSpan('llm', 'gpt-4o', { attributes: { model: 'gpt-4o', inputTokens: 100, outputTokens: 50 } });
  span.addEvent('approval', { decision: 'allowed' });
  span.finish('ok');
  const router = tracer.startSpan('router', 'pick-model');
  router.finish();
  const trace = tracer.toTrace('ok');
  const otel = traceToOtel(trace);
  assert.equal(otel.scopeSpans[0].spans.length, 2);
  assert.equal(otel.scopeSpans[0].spans[0].events.length, 1);
  assert.match(otel.scopeSpans[0].spans[0].traceId, /^[0-9a-f]{32}$/);

  const exporter = new OtelExporter(path.join(dir, 'otel.jsonl'));
  exporter.exportTrace(trace);
  const readBack = readOtelTraces(path.join(dir, 'otel.jsonl'));
  assert.equal(readBack.length, 1);

  const store = new TraceStore({ filePath: path.join(dir, 'traces.jsonl') });
  store.appendTrace(trace);
  const query = new TraceQuery(store);
  assert.equal(query.query({}).length, 1);
  const aggregate = query.aggregate({});
  assert.equal(aggregate.count, 1);
  assert.equal(aggregate.totalInputTokens, 100);
  assert.ok(aggregate.totalCostUsd > 0);
  const byModel = query.costByModel({});
  assert.equal(byModel.length, 1);
  assert.equal(byModel[0].model, 'gpt-4o');
  assert.equal(query.bucketByDay({}).length, 1);
  assert.equal(query.findErrorSpans({}).length, 0);
  assert.equal(query.timeline(trace).length, 2);
});
