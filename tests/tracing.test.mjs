/**
 * Tests for v0.10 run tracing (packages/core/src/tracing/).
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/tracing.test.mjs
 *
 * No API key, no network, no Electron: the tracer is in-memory and
 * the store writes to a temp dir.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  Tracer,
  TraceStore,
  createTraceId,
  sanitizeText,
  summarize,
  TRACES_FILE,
  DEFAULT_MAX_TRACES,
} from '../packages/core/dist/tracing/index.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-tracing-test-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

/** Deterministic clock: each call advances 10ms so durations are exact. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => (t += 10), value: () => t };
}

const SECRET = 'sk-test-ABCDEFGHIJKLMNOP';
const BEARER = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig';

/** A finished trace with one span of each wired kind (llm/tool/approval). */
function makeTrace({ store, botId = 'bot-1', runId = 'run-1' } = {}) {
  const c = clock();
  const tracer = new Tracer({ runId, botId, now: c.now, secrets: [SECRET] });
  const llm = tracer.startSpan('llm', 'grok-4', {
    input: 'hello',
    attributes: { model: 'grok-4', inputTokens: 12 },
  });
  llm.finish('hi there');
  const tool = tracer.startSpan('tool', 'read_file', {
    input: { path: '/tmp/a.txt' },
    parentSpanId: llm.span.id,
  });
  tool.finish('file contents');
  const approval = tracer.startSpan('approval', 'shell_exec', { input: { command: 'npm test' } });
  approval.finish('approved');
  const trace = tracer.toTrace();
  if (store) store.appendTrace(trace);
  return { tracer, trace };
}

// --- Tracer ---------------------------------------------------------------

test('tracer: spans finish in start order with measured durations', () => {
  const { tracer, trace } = makeTrace();
  assert.equal(tracer.spanCount, 3);
  assert.equal(trace.status, 'ok');
  assert.deepEqual(
    trace.spans.map((s) => s.kind),
    ['llm', 'tool', 'approval'],
  );
  assert.deepEqual(
    trace.spans.map((s) => s.name),
    ['grok-4', 'read_file', 'shell_exec'],
  );
  for (const span of trace.spans) {
    assert.equal(span.status, 'ok');
    assert.ok(span.durationMs !== null && span.durationMs >= 0);
    assert.equal(span.traceId, trace.traceId);
    assert.equal(span.runId, 'run-1');
    assert.equal(span.botId, 'bot-1');
  }
  // Durations come from the fake clock (10ms per tick).
  assert.equal(trace.durationMs, trace.spans.at(-1).endedAt - trace.spans[0].startedAt);
  assert.equal(trace.runId, 'run-1');
  assert.equal(trace.botId, 'bot-1');
});

test('tracer: traceId/runId/botId are carried on every span; createTraceId is unique', () => {
  const traceId = createTraceId();
  const tracer = new Tracer({ traceId, runId: 'run-9', botId: 'bot-9' });
  const handle = tracer.startSpan('tool', 'list_files');
  handle.finish('ok');
  assert.equal(tracer.traceId, traceId);
  assert.equal(tracer.spans[0].traceId, traceId);
  assert.notEqual(createTraceId(), createTraceId());
});

test('tracer: parentSpanId links a nested span to its parent', () => {
  const { trace } = makeTrace();
  const [llm, tool] = trace.spans;
  assert.equal(tool.parentSpanId, llm.id);
  assert.equal(llm.parentSpanId, undefined);
});

test('tracer: failSpan records the error and marks the trace as error', () => {
  const c = clock();
  const tracer = new Tracer({ runId: 'run-err', botId: 'bot-1', now: c.now });
  const span = tracer.startSpan('tool', 'shell_exec');
  tracer.failSpan(span.span.id, new Error('exit code 1'));
  const trace = tracer.toTrace();
  assert.equal(trace.status, 'error');
  assert.equal(trace.spans[0].status, 'error');
  assert.equal(trace.spans[0].error, 'exit code 1');
});

test('tracer: blockSpan marks a guardrail/approval block; finishing twice is a no-op', () => {
  const tracer = new Tracer({ runId: 'run-block', botId: 'bot-1' });
  const handle = tracer.startSpan('guardrail', 'output-pii-check');
  const blocked = handle.block('contains an email address');
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.outputSummary, /email address/);
  // Second finish must not overwrite the blocked outcome.
  const again = tracer.finishSpan(blocked.id, 'different output');
  assert.equal(again.status, 'blocked');
  assert.match(again.outputSummary, /email address/);
  assert.equal(tracer.toTrace().status, 'ok');
});

test('tracer: completeSpan records an already-timed span in one call', () => {
  const tracer = new Tracer({ runId: 'run-c', botId: 'bot-1' });
  const span = tracer.completeSpan('handoff', 'transfer_to_researcher', {
    input: { reason: 'needs web search' },
    output: 'handoff accepted',
    startedAt: 1000,
    endedAt: 1250,
  });
  assert.equal(span.status, 'ok');
  assert.equal(span.durationMs, 250);
  assert.equal(span.inputSummary, '{"reason":"needs web search"}');
});

test('tracer: constructor rejects an empty runId/botId; startSpan rejects an empty name', () => {
  assert.throws(() => new Tracer({ runId: '', botId: 'b' }), /runId/);
  assert.throws(() => new Tracer({ runId: 'r', botId: '' }), /botId/);
  const tracer = new Tracer({ runId: 'r', botId: 'b' });
  assert.throws(() => tracer.startSpan('tool', '  '), /span name/);
  assert.equal(tracer.finishSpan('no-such-id'), null);
});

test('tracer: save() persists through a TraceSink and returns the trace', () => {
  const dir = makeTempDir();
  const store = new TraceStore({ filePath: path.join(dir, TRACES_FILE) });
  const tracer = new Tracer({ runId: 'run-save', botId: 'bot-1' });
  tracer.startSpan('llm', 'model-x').finish('done');
  const saved = tracer.save(store);
  assert.equal(saved.traceId, tracer.traceId);
  assert.equal(store.count(), 1);
  assert.equal(store.getTrace(saved.traceId).runId, 'run-save');
});

// --- Sanitisation: no secret ever reaches a span or the JSONL file ------

test('sanitize: secret values, Bearer tokens and key shapes are redacted', () => {
  assert.equal(sanitizeText(`key is ${SECRET}`, [SECRET]), 'key is <redacted>');
  assert.equal(sanitizeText(`Authorization: ${BEARER}`), 'Authorization: Bearer <redacted>');
  assert.equal(sanitizeText('xai-abcdefgh12345678'), '<redacted>');
  assert.equal(sanitizeText('apiKey: hunter2-secret-value'), 'apiKey=<redacted>');
  assert.doesNotMatch(sanitizeText(`apiKey=${SECRET} and ${BEARER}`, [SECRET]), /sk-test|eyJhbGci/);
});

test('sanitize: credential object keys are redacted, other keys survive', () => {
  const out = summarize({ apiKey: SECRET, token: 'tok-123', path: '/tmp/a.txt', count: 3 });
  assert.doesNotMatch(out, /sk-test|tok-123/);
  assert.match(out, /"apiKey":"<redacted>"/);
  assert.match(out, /"token":"<redacted>"/);
  assert.match(out, /"path":"\/tmp\/a.txt"/);
  assert.match(out, /"count":3/);
});

test('tracing: JSONL file never contains a secret written into a span', () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, TRACES_FILE);
  const store = new TraceStore({ filePath });
  const c = clock();
  const tracer = new Tracer({ runId: 'run-sec', botId: 'bot-1', now: c.now, secrets: [SECRET] });
  tracer
    .startSpan('tool', 'http_fetch', {
      input: { url: 'https://api.example.com', headers: { Authorization: BEARER, 'X-Api-Key': SECRET } },
    })
    .finish(`called with ${SECRET}`);
  tracer.startSpan('llm', 'grok-4', { input: `my key is ${SECRET}` }).finish('ok');
  tracer.save(store);
  const raw = fs.readFileSync(filePath, 'utf-8');
  assert.doesNotMatch(raw, new RegExp(SECRET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(raw, /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/);
  assert.match(raw, /<redacted>/);
  // The trace still round-trips after sanitisation.
  const back = store.getTraceByRunId('run-sec');
  assert.equal(back.spans.length, 2);
  assert.match(back.spans[0].outputSummary, /<redacted>/);
});

test('tracing: long inputs are truncated to a summary, not stored whole', () => {
  const tracer = new Tracer({ runId: 'run-long', botId: 'bot-1' });
  const big = 'x'.repeat(10_000);
  const span = tracer.startSpan('llm', 'model', { input: big }).finish(big);
  assert.ok(span.inputSummary.length < 1000);
  assert.match(span.inputSummary, /\[truncated\]/);
});

// --- TraceStore ------------------------------------------------------------

test('store: append + list + get round-trip, newest first', () => {
  const dir = makeTempDir();
  const store = new TraceStore({ filePath: path.join(dir, TRACES_FILE) });
  assert.equal(store.count(), 0);
  assert.equal(store.getTrace('missing'), null);
  assert.equal(store.getTraceByRunId('missing'), null);
  assert.deepEqual(store.listTraces(), []);

  const first = makeTrace({ store, runId: 'run-1' }).trace;
  const second = makeTrace({ store, runId: 'run-2', botId: 'bot-2' }).trace;

  assert.equal(store.count(), 2);
  const listed = store.listTraces();
  assert.deepEqual(
    listed.map((s) => s.runId),
    ['run-2', 'run-1'],
  );
  assert.equal(listed[0].spanCount, 3);
  assert.deepEqual(listed[0].kinds, ['llm', 'tool', 'approval']);
  assert.equal(listed[0].traceId, second.traceId);

  const got = store.getTrace(first.traceId);
  assert.equal(got.runId, 'run-1');
  assert.equal(got.spans.length, 3);
  assert.equal(got.spans[0].name, 'grok-4');
  assert.equal(store.getTraceByRunId('run-2').traceId, second.traceId);

  // Filters.
  assert.deepEqual(
    store.listTraces({ botId: 'bot-2' }).map((s) => s.runId),
    ['run-2'],
  );
  assert.deepEqual(
    store.listTraces({ runId: 'run-1' }).map((s) => s.runId),
    ['run-1'],
  );
  assert.equal(store.listTraces({ limit: 1 }).length, 1);
});

test('store: corrupt lines are skipped, the rest still loads', () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, TRACES_FILE);
  const store = new TraceStore({ filePath });
  makeTrace({ store, runId: 'run-1' });
  fs.appendFileSync(filePath, '{"traceId": broken json\n');
  fs.appendFileSync(filePath, '{"traceId": 1, "spans": "not-an-array"}\n');
  makeTrace({ store, runId: 'run-2' });
  assert.equal(store.count(), 2);
  assert.deepEqual(
    store.listTraces().map((s) => s.runId),
    ['run-2', 'run-1'],
  );
});

test('store: cap drops the oldest traces first', () => {
  const dir = makeTempDir();
  const store = new TraceStore({ filePath: path.join(dir, TRACES_FILE), maxTraces: 3 });
  for (let i = 1; i <= 5; i += 1) {
    makeTrace({ store, runId: `run-${i}` });
  }
  assert.equal(store.count(), 3);
  assert.deepEqual(
    store.listTraces().map((s) => s.runId),
    ['run-5', 'run-4', 'run-3'],
  );
  assert.equal(store.getTraceByRunId('run-1'), null);
  assert.equal(store.getTraceByRunId('run-2'), null);
  assert.notEqual(store.getTraceByRunId('run-5'), null);
});

test('store: default maxTraces is 100; clear removes the file', () => {
  assert.equal(DEFAULT_MAX_TRACES, 100);
  const dir = makeTempDir();
  const filePath = path.join(dir, TRACES_FILE);
  const store = new TraceStore({ filePath });
  makeTrace({ store, runId: 'run-1' });
  assert.equal(fs.existsSync(filePath), true);
  store.clear();
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(store.count(), 0);
});

test('store: appendTrace rejects a trace without ids', () => {
  const dir = makeTempDir();
  const store = new TraceStore({ filePath: path.join(dir, TRACES_FILE) });
  assert.throws(() => store.appendTrace({ traceId: '', runId: 'r', botId: 'b', spans: [] }), /traceId/);
  assert.throws(
    () => store.appendTrace({ traceId: 't', runId: '', botId: 'b', spans: [] }),
    /runId and botId/,
  );
});
