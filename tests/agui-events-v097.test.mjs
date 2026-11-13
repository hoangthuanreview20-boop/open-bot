/**
 * AG-UI 1.0 unit tests (v0.97, Team T3).
 *
 * Covers packages/core/src/agui/: the 16 event types + validator,
 * the event bus (sequence, filter, replay buffer, never-throw), the
 * run state store (snapshot / delta / prototype safety), the
 * generative-UI registry (all six kinds + response validation +
 * expiry), the SSE formatter/parser, the runtime emitter (including
 * the mock/CLI exemption), and the harness -> AG-UI bridge.
 *
 * No network, no provider, no Ollama, no real bot: everything runs
 * in-process against the built core dist.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/agui-events-v097.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AG_UI_EVENT_TYPES,
  AgUiEventBus,
  AgUiGenerativeUiRegistry,
  AgUiRuntimeEmitter,
  AgUiStateStore,
  AgUiValidationError,
  applyAgUiStateDelta,
  formatAgUiSseEvent,
  formatAgUiSseHeartbeat,
  formatAgUiSseReplay,
  harnessEventToAgUi,
  isAgUiBridgeEngine,
  isAgUiExemptProvider,
  isTerminalAgUiEvent,
  isValidAgUiEvent,
  makeAgUiEvent,
  parseAgUiLastEventId,
  parseAgUiSseChunk,
  replayFromForLastEventId,
  shouldEmitAgUiForProvider,
  validateAgUiEvent,
  validateGenerativeUiRequest,
} from '../packages/core/dist/index.js';

function runStarted(runId = 'run-1', botId = 'bot-1') {
  return makeAgUiEvent('RUN_STARTED', runId, { title: 'hello' }, { botId, threadId: botId });
}

function textContent(runId, messageId, delta, sequence) {
  const event = makeAgUiEvent(
    'TEXT_MESSAGE_CONTENT',
    runId,
    { messageId, delta },
    { botId: 'bot-1', messageId },
  );
  if (sequence !== undefined) event.sequence = sequence;
  return event;
}

// ---------------------------------------------------------------------------
// Event types + validation
// ---------------------------------------------------------------------------

test('agui: exactly 16 standard event types', () => {
  assert.equal(AG_UI_EVENT_TYPES.length, 16);
  for (const type of [
    'RUN_STARTED',
    'RUN_FINISHED',
    'RUN_ERROR',
    'TEXT_MESSAGE_START',
    'TEXT_MESSAGE_CONTENT',
    'TEXT_MESSAGE_END',
    'TOOL_CALL_START',
    'TOOL_CALL_ARGS',
    'TOOL_CALL_END',
    'TOOL_CALL_RESULT',
    'STATE_SNAPSHOT',
    'STATE_DELTA',
    'CUSTOM',
    'GENERATIVE_UI',
    'GENERATIVE_UI_RESPONSE',
    'ACTIVITY',
  ]) {
    assert.ok(AG_UI_EVENT_TYPES.includes(type), `missing type ${type}`);
  }
  assert.equal(new Set(AG_UI_EVENT_TYPES).size, 16, 'types must be unique');
});

test('agui: validateAgUiEvent accepts a well-formed event and cleans it', () => {
  const cleaned = validateAgUiEvent({
    protocol: 'agui/1.0',
    type: 'TOOL_CALL_ARGS',
    runId: 'run-1',
    botId: 'bot-1',
    timestamp: new Date().toISOString(),
    extraTopLevel: 'dropped',
    data: { toolCallId: 'c1', toolName: 'read_file', argKeys: ['path'], complete: true },
  });
  assert.equal(cleaned.type, 'TOOL_CALL_ARGS');
  assert.equal(cleaned.data.toolName, 'read_file');
  assert.equal('extraTopLevel' in cleaned, false, 'unknown top-level fields are dropped');
  assert.equal(isValidAgUiEvent(cleaned), true);
});

test('agui: validator rejects wrong protocol, unknown type, bad timestamp', () => {
  assert.equal(isValidAgUiEvent({ protocol: 'agui/2.0', type: 'RUN_STARTED', runId: 'r', timestamp: new Date().toISOString(), data: {} }), false);
  assert.equal(isValidAgUiEvent({ protocol: 'agui/1.0', type: 'NOPE', runId: 'r', timestamp: new Date().toISOString(), data: {} }), false);
  assert.equal(isValidAgUiEvent({ protocol: 'agui/1.0', type: 'RUN_STARTED', runId: 'r', timestamp: 'not-a-date', data: {} }), false);
  assert.equal(isValidAgUiEvent({ protocol: 'agui/1.0', type: 'RUN_STARTED', runId: '', timestamp: new Date().toISOString(), data: {} }), false);
  assert.throws(() => validateAgUiEvent({ protocol: 'agui/1.0', type: 'RUN_FINISHED', runId: 'r', timestamp: new Date().toISOString(), data: { status: 'weird' } }), AgUiValidationError);
});

test('agui: validator rejects secret keys in tool args and prototype paths in deltas', () => {
  assert.equal(
    isValidAgUiEvent(
      makeAgUiEvent('TOOL_CALL_ARGS', 'r', { toolCallId: 'c1', toolName: 't', argKeys: ['apiKey'] }),
    ),
    false,
  );
  assert.equal(
    isValidAgUiEvent(
      makeAgUiEvent('STATE_DELTA', 'r', {
        operations: [{ op: 'set', path: '__proto__.polluted', value: 1 }],
      }),
    ),
    false,
  );
  assert.equal(
    isValidAgUiEvent(
      makeAgUiEvent('STATE_DELTA', 'r', {
        operations: [{ op: 'set', path: 'progress.current', value: 3 }],
      }),
    ),
    true,
  );
  assert.equal(
    isValidAgUiEvent(
      makeAgUiEvent('ACTIVITY', 'r', { kind: 'thinking', label: 'x', progress: 1.5 }),
    ),
    false,
    'progress above 1 is rejected',
  );
});

test('agui: validator truncates over-long text instead of rejecting it', () => {
  const cleaned = validateAgUiEvent(
    makeAgUiEvent('TEXT_MESSAGE_CONTENT', 'r', { messageId: 'm1', delta: 'x'.repeat(9000) }),
  );
  assert.ok(cleaned.data.delta.length <= 8000);
  assert.ok(cleaned.data.delta.endsWith('...'));
});

// ---------------------------------------------------------------------------
// Bus
// ---------------------------------------------------------------------------

test('agui bus: publish assigns per-run sequences and fans out to matching subscribers', () => {
  const bus = new AgUiEventBus();
  const seen = [];
  bus.subscribe({ runId: 'run-1' }, (event) => seen.push(event));
  bus.subscribe({ types: ['RUN_ERROR'] }, () => {
    throw new Error('handler boom');
  });
  const first = bus.publish(runStarted('run-1'));
  const second = bus.publish(runStarted('run-2'));
  const third = bus.publish(textContent('run-1', 'm1', 'hello'));
  assert.equal(first?.sequence, 0);
  assert.equal(second?.sequence, 0, 'sequences are per-run');
  assert.equal(third?.sequence, 1);
  assert.equal(seen.length, 2, 'only run-1 events reach the run-1 subscriber');
  assert.equal(bus.totalHandlerErrors, 0, 'no error handler subscribed yet for these types');
  const errorEvent = makeAgUiEvent('RUN_ERROR', 'run-1', { message: 'boom' }, { botId: 'bot-1' });
  bus.publish(errorEvent);
  assert.equal(bus.totalHandlerErrors, 1, 'a throwing handler is counted, not fatal');
  assert.equal(bus.stats.published, 4);
});

test('agui bus: invalid events are dropped and counted, never delivered', () => {
  const bus = new AgUiEventBus();
  const seen = [];
  bus.subscribe({}, (event) => seen.push(event));
  const result = bus.publish({ protocol: 'agui/1.0', type: 'NOPE', runId: 'r', timestamp: new Date().toISOString(), data: {} });
  assert.equal(result, null);
  assert.equal(seen.length, 0);
  assert.equal(bus.totalDroppedInvalid, 1);
  assert.equal(bus.totalPublished, 0);
});

test('agui bus: replay buffer returns events from a sequence, capped per run', () => {
  const bus = new AgUiEventBus({ replayPerRun: 3 });
  for (let i = 0; i < 5; i++) {
    bus.publish(textContent('run-1', 'm1', `chunk-${i}`));
  }
  const replayed = bus.replay('run-1');
  assert.equal(replayed.length, 3, 'buffer keeps the newest 3');
  assert.deepEqual(replayed.map((e) => e.data.delta), ['chunk-2', 'chunk-3', 'chunk-4']);
  assert.deepEqual(
    bus.replay('run-1', 4).map((e) => e.sequence),
    [4],
  );
  assert.deepEqual(bus.replay('run-unknown'), []);
  assert.equal(bus.lastEvent('run-1')?.data.delta, 'chunk-4');
});

test('agui bus: unsubscribe is idempotent and stops delivery', () => {
  const bus = new AgUiEventBus();
  const seen = [];
  const unsubscribe = bus.subscribe({}, (event) => seen.push(event));
  bus.publish(runStarted());
  unsubscribe();
  unsubscribe();
  bus.publish(runStarted());
  assert.equal(seen.length, 1);
  assert.equal(bus.subscriberCount, 0);
});

test('agui bus: filter by bot, thread, types and minSequence', () => {
  const bus = new AgUiEventBus();
  const seen = [];
  bus.subscribe(
    { botId: 'bot-1', types: ['TEXT_MESSAGE_CONTENT'], minSequence: 1 },
    (event) => seen.push(event),
  );
  bus.publish(textContent('run-1', 'm1', 'a')); // sequence 0 -> filtered by minSequence
  bus.publish(textContent('run-1', 'm1', 'b')); // sequence 1 -> delivered
  bus.publish(makeAgUiEvent('TEXT_MESSAGE_CONTENT', 'run-2', { messageId: 'm2', delta: 'c' }, { botId: 'bot-2' }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].data.delta, 'b');
});

// ---------------------------------------------------------------------------
// State store
// ---------------------------------------------------------------------------

test('agui state: snapshot then delta set/delete/append', () => {
  const store = new AgUiStateStore();
  const snapshot = store.applySnapshot('run-1', { status: 'running', items: ['a'], count: 1 }, 0, { botId: 'bot-1' });
  assert.equal(snapshot?.state.status, 'running');
  const after = store.applyDelta(
    'run-1',
    [
      { op: 'set', path: 'count', value: 2 },
      { op: 'append', path: 'items', value: 'b' },
      { op: 'set', path: 'progress.current', value: 5 },
    ],
    1,
  );
  assert.equal(after?.state.count, 2);
  assert.deepEqual(after?.state.items, ['a', 'b']);
  assert.deepEqual(after?.state.progress, { current: 5 });
  const deleted = store.applyDelta('run-1', [{ op: 'delete', path: 'count' }], 2);
  assert.equal('count' in (deleted?.state ?? {}), false);
  assert.equal(store.get('run-1')?.version, 2);
  assert.equal(store.get('run-1')?.appliedEvents, 3);
});

test('agui state: out-of-order snapshot is ignored, delta on unknown run starts empty', () => {
  const store = new AgUiStateStore();
  store.applySnapshot('run-1', { a: 1 }, 5);
  const ignored = store.applySnapshot('run-1', { a: 2 }, 3);
  assert.equal(ignored, null);
  assert.equal(store.get('run-1')?.state.a, 1);
  const fresh = store.applyDelta('run-1', [{ op: 'set', path: 'b', value: 2 }], 6);
  assert.equal(fresh?.state.b, 2);
  const other = store.applyDelta('run-9', [{ op: 'set', path: 'x', value: 1 }], 0);
  assert.equal(other?.state.x, 1);
});

test('agui state: applyAgUiStateDelta is pure and rejects prototype paths', () => {
  const input = { a: 1 };
  const out = applyAgUiStateDelta(input, [{ op: 'set', path: 'b.c', value: 2 }]);
  assert.deepEqual(input, { a: 1 }, 'input is never mutated');
  assert.deepEqual(out, { a: 1, b: { c: 2 } });
  assert.throws(() => applyAgUiStateDelta({}, [{ op: 'set', path: '__proto__.x', value: 1 }]));
  assert.throws(() => applyAgUiStateDelta({ list: 1 }, [{ op: 'append', path: 'list', value: 2 }]));
});

// ---------------------------------------------------------------------------
// Generative UI
// ---------------------------------------------------------------------------

test('agui genui: all six kinds validate', () => {
  const base = { runId: 'run-1', botId: 'bot-1' };
  const requests = [
    validateGenerativeUiRequest({ componentId: 'c1', kind: 'confirm', title: 'Sure?', props: { summary: 'Deletes one file.' } }, 'run-1', 'bot-1'),
    validateGenerativeUiRequest({ componentId: 'c2', kind: 'options', title: 'Pick', props: { options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B', hint: 'second' }] } }, 'run-1', 'bot-1'),
    validateGenerativeUiRequest({ componentId: 'c3', kind: 'form', title: 'Form', props: { fields: [{ name: 'name', label: 'Name', type: 'text', required: true }, { name: 'size', label: 'Size', type: 'select', options: ['S', 'M'] }] } }, 'run-1', 'bot-1'),
    validateGenerativeUiRequest({ componentId: 'c4', kind: 'table', title: 'Table', props: { columns: [{ key: 'name', label: 'Name' }], rows: [{ name: 'x' }] } }, 'run-1', 'bot-1'),
    validateGenerativeUiRequest({ componentId: 'c5', kind: 'progress', title: 'Progress', props: { value: 0.5, label: 'Half' } }, 'run-1', 'bot-1'),
    validateGenerativeUiRequest({ componentId: 'c6', kind: 'message', title: 'Note', props: { body: 'Hello', tone: 'info' } }, 'run-1', 'bot-1'),
  ];
  assert.equal(requests.length, 6);
  assert.equal(requests[1].props.options.length, 2);
  assert.equal(requests[2].props.fields.length, 2);
  assert.equal(base.runId, 'run-1');
});

test('agui genui: invalid shapes are rejected', () => {
  assert.throws(() =>
    validateGenerativeUiRequest({ componentId: 'c1', kind: 'options', title: 'Pick', props: { options: [] } }, 'run-1'),
  );
  assert.throws(() =>
    validateGenerativeUiRequest({ componentId: 'c1', kind: 'options', title: 'Pick', props: { options: [{ value: 'a', label: 'A' }, { value: 'a', label: 'dup' }] } }, 'run-1'),
  );
  assert.throws(() =>
    validateGenerativeUiRequest({ componentId: 'c1', kind: 'progress', title: 'P', props: { value: 2 } }, 'run-1'),
  );
  assert.throws(() =>
    validateGenerativeUiRequest({ componentId: 'c1', kind: 'form', title: 'F', props: { fields: [{ name: 'bad-name!', label: 'x', type: 'text' }] } }, 'run-1'),
  );
  assert.throws(() =>
    validateGenerativeUiRequest({ componentId: 'c1', kind: 'message', title: 'M', props: { body: '<script>alert(1)</script>' } }, 'run-1'),
  );
});

test('agui genui: registry tracks pending, answers once, expires stale', () => {
  const registry = new AgUiGenerativeUiRegistry({ ttlMs: 1000 });
  const request = validateGenerativeUiRequest(
    { componentId: 'c1', kind: 'confirm', title: 'Sure?', props: {} },
    'run-1',
    'bot-1',
  );
  registry.request(request);
  assert.equal(registry.pendingForRun('run-1').length, 1);
  const answered = registry.answer('c1', { componentId: 'c1', response: { confirmed: true }, action: 'confirm' });
  assert.equal(answered.status, 'answered');
  assert.equal(registry.pendingForRun('run-1').length, 0);
  assert.throws(() => registry.answer('c1', { componentId: 'c1', response: { confirmed: true } }), /already answered/);
  assert.throws(() => registry.answer('missing', { componentId: 'missing', response: {} }), /No generative UI component/);

  const request2 = validateGenerativeUiRequest(
    { componentId: 'c2', kind: 'options', title: 'Pick', props: { options: [{ value: 'a', label: 'A' }] } },
    'run-1',
  );
  registry.request(request2);
  assert.throws(() =>
    registry.answer('c2', { componentId: 'c2', response: { selected: 'zzz' } }),
  );
  const expired = registry.expire(Date.now() + 60_000);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].status, 'expired');
});

test('agui genui: form response enforces required fields and select options', () => {
  const registry = new AgUiGenerativeUiRegistry();
  const request = validateGenerativeUiRequest(
    {
      componentId: 'f1',
      kind: 'form',
      title: 'Form',
      props: { fields: [{ name: 'size', label: 'Size', type: 'select', options: ['S', 'M'], required: true }] },
    },
    'run-1',
  );
  registry.request(request);
  assert.throws(() => registry.answer('f1', { componentId: 'f1', response: {} }), /missing required field/);
  assert.throws(() =>
    registry.answer('f1', { componentId: 'f1', response: { size: 'XL' } }),
  );
  const ok = registry.answer('f1', { componentId: 'f1', response: { size: 'M' }, action: 'submit' });
  assert.equal(ok.status, 'answered');
});

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

test('agui sse: format + parse round-trip, heartbeat, terminal detection', () => {
  const event = makeAgUiEvent('RUN_FINISHED', 'run-1', { status: 'completed' }, { botId: 'bot-1' });
  event.sequence = 7;
  const frame = formatAgUiSseEvent(event);
  assert.match(frame, /^id: run-1:7\nevent: RUN_FINISHED\ndata: /);
  const { frames, pending } = parseAgUiSseChunk(`${formatAgUiSseHeartbeat()}${frame}`);
  assert.equal(pending, '');
  assert.equal(frames.length, 2);
  assert.equal(frames[0].heartbeat, true);
  assert.equal(frames[1].data?.type, 'RUN_FINISHED');
  assert.equal(frames[1].data?.sequence, 7);
  assert.equal(isTerminalAgUiEvent(event), true);
  assert.equal(isTerminalAgUiEvent(makeAgUiEvent('TEXT_MESSAGE_CONTENT', 'run-1', { messageId: 'm', delta: 'x' })), false);
});

test('agui sse: Last-Event-ID parsing and replay-from computation', () => {
  assert.deepEqual(parseAgUiLastEventId('run-1:12'), { runId: 'run-1', sequence: 12 });
  assert.deepEqual(parseAgUiLastEventId('12'), { sequence: 12 });
  assert.equal(parseAgUiLastEventId(''), null);
  assert.equal(parseAgUiLastEventId(undefined), null);
  assert.equal(parseAgUiLastEventId('run-1:not-a-number'), null);
  assert.equal(replayFromForLastEventId('run-1:12', 'run-1'), 13);
  assert.equal(replayFromForLastEventId('run-2:12', 'run-1'), 0, 'stale id from another run replays from 0');
  assert.equal(replayFromForLastEventId(undefined, 'run-1'), 0);
});

test('agui sse: replay formatting caps at 1000 events', () => {
  const events = Array.from({ length: 5 }, (_, i) => {
    const event = makeAgUiEvent('CUSTOM', 'run-1', { name: `n${i}` });
    event.sequence = i;
    return event;
  });
  const body = formatAgUiSseReplay(events);
  assert.equal(body.split('\n\n').filter(Boolean).length, 5);
});

// ---------------------------------------------------------------------------
// Exemption + emitter + bridge
// ---------------------------------------------------------------------------

test('agui exemption: mock and every CLI provider are exempt, API providers emit', () => {
  assert.equal(isAgUiExemptProvider('mock'), true);
  for (const id of ['claude-code', 'codex', 'grok-cli', 'opencode', 'gemini-cli', 'cursor-cli', 'custom-acp', 'aider', 'continue-cli', 'amazon-q', 'copilot-cli', 'windsurf', 'kiro-cli']) {
    assert.equal(isAgUiExemptProvider(id), true, id);
  }
  assert.equal(isAgUiExemptProvider('custom-acp:my-cli'), true, 'custom-acp:<slug> is a CLI run');
  for (const id of ['openai', 'anthropic', 'gemini', 'xai', 'ollama', 'openai-compatible']) {
    assert.equal(isAgUiExemptProvider(id), false, id);
    assert.equal(shouldEmitAgUiForProvider(id), true, id);
  }
  assert.equal(shouldEmitAgUiForProvider('mock'), false);
  assert.equal(isAgUiBridgeEngine('claude-code'), true, 'CLI engines are bridged');
  assert.equal(isAgUiBridgeEngine('openai'), false, 'API engines are not bridged (no duplicates)');
  assert.equal(isAgUiBridgeEngine(undefined), false);
});

test('agui emitter: full run lifecycle for an API provider', () => {
  const bus = new AgUiEventBus();
  const store = new AgUiStateStore();
  const seen = [];
  bus.subscribe({}, (event) => seen.push(event));
  const emitter = new AgUiRuntimeEmitter({
    bus,
    stateStore: store,
    runId: 'run-1',
    botId: 'bot-1',
    providerId: 'openai',
    model: 'gpt-5',
  });
  assert.equal(emitter.active, true);
  emitter.runStarted({ title: 'do the thing', toolCount: 3 });
  emitter.textContent('hello ');
  emitter.textContent('world');
  emitter.textEnd();
  emitter.toolCallStart('c1', 'read_file', { path: 'a.txt' });
  emitter.toolCallEnd('c1', 'ok');
  emitter.toolCallResult('c1', 'read_file', true, 'file contents here');
  emitter.runFinished('completed', 'hello world');
  const types = seen.map((e) => e.type);
  assert.deepEqual(types, [
    'RUN_STARTED',
    'STATE_SNAPSHOT',
    'TEXT_MESSAGE_START',
    'TEXT_MESSAGE_CONTENT',
    'TEXT_MESSAGE_CONTENT',
    'TEXT_MESSAGE_END',
    'TOOL_CALL_START',
    'TOOL_CALL_ARGS',
    'TOOL_CALL_END',
    'STATE_DELTA',
    'TOOL_CALL_RESULT',
    'RUN_FINISHED',
    'STATE_SNAPSHOT',
  ]);
  const args = seen.find((e) => e.type === 'TOOL_CALL_ARGS');
  assert.deepEqual(args.data.argKeys, ['path']);
  assert.equal(args.data.argsJson.includes('a.txt'), true);
  const finished = seen.find((e) => e.type === 'RUN_FINISHED');
  assert.equal(finished.data.status, 'completed');
  assert.equal(finished.data.toolCalls, 1);
  assert.equal(store.get('run-1')?.state.status, 'completed');
  // A second finish is a no-op (runs finish once).
  emitter.runFinished('completed', 'again');
  assert.equal(seen.filter((e) => e.type === 'RUN_FINISHED').length, 1);
});

test('agui emitter: mock / CLI / silent emitters publish nothing', () => {
  const bus = new AgUiEventBus();
  for (const providerId of ['mock', 'claude-code', 'codex']) {
    const emitter = new AgUiRuntimeEmitter({ bus, runId: `run-${providerId}`, botId: 'bot-1', providerId });
    assert.equal(emitter.active, false, providerId);
    emitter.runStarted({ title: 'x' });
    emitter.textContent('hello');
    emitter.toolCallStart('c1', 'read_file', {});
    emitter.runFinished('completed', 'done');
  }
  const silent = new AgUiRuntimeEmitter({ bus, runId: 'run-silent', botId: 'bot-1', providerId: 'openai', silent: true });
  assert.equal(silent.active, false);
  silent.runStarted({ title: 'x' });
  assert.equal(bus.totalPublished, 0);
});

test('agui emitter: tool args never carry values for secrets, generative UI round-trips', () => {
  const bus = new AgUiEventBus();
  const registry = new AgUiGenerativeUiRegistry();
  const seen = [];
  bus.subscribe({}, (event) => seen.push(event));
  const emitter = new AgUiRuntimeEmitter({ bus, genUiRegistry: registry, runId: 'run-1', botId: 'bot-1', providerId: 'gemini' });
  const componentId = emitter.requestGenerativeUi({
    kind: 'options',
    title: 'Pick one',
    props: { options: [{ value: 'a', label: 'A' }] },
  });
  assert.ok(componentId);
  assert.equal(registry.pendingForRun('run-1').length, 1);
  assert.equal(seen.find((e) => e.type === 'GENERATIVE_UI')?.data.componentId, componentId);
  assert.equal(emitter.answerGenerativeUi(componentId, { selected: 'a' }, 'submit'), true);
  assert.equal(seen.filter((e) => e.type === 'GENERATIVE_UI_RESPONSE').length, 1);
  assert.equal(emitter.answerGenerativeUi('missing', {}, 'submit'), false);
  assert.equal(emitter.requestGenerativeUi({ kind: 'progress', title: 'P', props: { value: 2 } }), null, 'invalid component is rejected, not emitted');
});

test('agui bridge: harness events map to AG-UI, unknown kinds map to null', () => {
  const at = new Date().toISOString();
  const start = harnessEventToAgUi(
    { instanceId: 'i1', botId: 'bot-1', threadId: 'bot-1', engine: 'claude-code', kind: 'lifecycle', payload: { phase: 'turn-start' }, at },
    'run-9',
  );
  assert.equal(start?.type, 'RUN_STARTED');
  assert.equal(start?.runId, 'run-9');
  const text = harnessEventToAgUi(
    { instanceId: 'i1', botId: 'bot-1', threadId: 'bot-1', engine: 'claude-code', kind: 'text', payload: { delta: 'hi' }, at },
    'run-9',
  );
  assert.equal(text?.type, 'TEXT_MESSAGE_CONTENT');
  assert.equal(text?.data.delta, 'hi');
  const tool = harnessEventToAgUi(
    { instanceId: 'i1', botId: 'bot-1', threadId: 'bot-1', engine: 'claude-code', kind: 'tool_call', payload: { callId: 'c1', tool: 'read_file' }, at },
    'run-9',
  );
  assert.equal(tool?.type, 'TOOL_CALL_START');
  const router = harnessEventToAgUi(
    { instanceId: 'i1', botId: 'bot-1', threadId: 'bot-1', engine: 'openai', kind: 'router.decision', payload: {}, at },
    'run-9',
  );
  assert.equal(router, null);
});
