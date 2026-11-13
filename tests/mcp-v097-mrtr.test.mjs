/**
 * Test v0.97 T1: Multi Round-Trip Requests — MRTR (node:test).
 * Local only, no live network: fake transports script the rounds.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v097-mrtr.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMrtrFollowUpParams,
  buildMrtrResult,
  isMrtrResultType,
  mrtrNeedsFollowUp,
  parseMrtrResult,
  resolveMrtrNeed,
  runMultiRoundTrip,
  MRTR_FOLLOW_UP_TYPES,
  MrtrError,
} from '../packages/core/dist/mcp/mrtr.js';

function scriptedTransport(rounds) {
  let i = 0;
  return {
    calls: [],
    async requestJsonRpc(method, params) {
      this.calls.push({ method, params });
      const next = rounds[i++];
      if (next === undefined) throw new Error('scripted transport ran out of rounds');
      return typeof next === 'function' ? next(method, params) : next;
    },
  };
}

test('mrtr: result types — complete plus five follow-up kinds', () => {
  assert.equal(isMrtrResultType('complete'), true);
  for (const kind of MRTR_FOLLOW_UP_TYPES) assert.equal(isMrtrResultType(kind), true);
  assert.deepEqual([...MRTR_FOLLOW_UP_TYPES].sort(), [
    'needs_confirmation',
    'needs_elicitation',
    'needs_input',
    'needs_roots',
    'needs_sampling',
  ]);
  assert.equal(isMrtrResultType('needs_everything'), false);
  assert.equal(isMrtrResultType(undefined), false);
});

test('mrtr: parseMrtrResult treats a legacy result (no resultType) as complete', () => {
  assert.deepEqual(parseMrtrResult({ content: [{ type: 'text', text: 'hi' }] }), {
    resultType: 'complete',
    result: { content: [{ type: 'text', text: 'hi' }] },
  });
  assert.deepEqual(parseMrtrResult('plain text'), { resultType: 'complete', result: 'plain text' });
  const need = parseMrtrResult(
    buildMrtrResult('needs_input', {
      need: { prompt: 'Missing field "path".', schema: { type: 'object' } },
      roundTripId: 'rt-9',
      note: 'round 1 of 2',
    }),
  );
  assert.equal(need.resultType, 'needs_input');
  assert.equal(need.need?.prompt, 'Missing field "path".');
  assert.equal(need.roundTripId, 'rt-9');
  assert.equal(need.note, 'round 1 of 2');
  assert.equal(mrtrNeedsFollowUp(need), true);
  assert.equal(mrtrNeedsFollowUp({ resultType: 'complete' }), false);
  assert.throws(() => parseMrtrResult({ resultType: 'needs_magic' }), MrtrError);
});

test('mrtr: buildMrtrResult shapes are consistent (need on follow-up, result on complete)', () => {
  const followUp = buildMrtrResult('needs_sampling', {
    need: { prompt: 'Summarize this.' },
    roundTripId: 'rt-1',
  });
  assert.equal(followUp['resultType'], 'needs_sampling');
  assert.equal(followUp['need']['resultType'], 'needs_sampling');
  assert.equal(followUp['need']['prompt'], 'Summarize this.');
  const done = buildMrtrResult('complete', { result: { ok: true } });
  assert.deepEqual(done['result'], { ok: true });
  assert.equal(done['need'], undefined);
});

test('mrtr: buildMrtrFollowUpParams carries the continuation in _meta and the answer', () => {
  const params = buildMrtrFollowUpParams({ name: 'read_file' }, 'rt-1', 2, { path: '/tmp/x' });
  assert.equal(params['answer']['path'], '/tmp/x');
  assert.equal(params['roundTripId'], 'rt-1');
  assert.equal(params['round'], 2);
  assert.equal(params['_meta']['roundTrip']['roundTripId'], 'rt-1');
  assert.equal(params['_meta']['roundTrip']['round'], 2);
  assert.equal(params['name'], 'read_file');
});

test('mrtr: single round — server answers complete at once', async () => {
  const transport = scriptedTransport([{ resultType: 'complete', result: 'done' }]);
  const outcome = await runMultiRoundTrip(transport, 'tools/call', { name: 'ping' }, {});
  assert.equal(outcome.result, 'done');
  assert.equal(outcome.rounds, 1);
  assert.equal(outcome.history.length, 1);
  assert.equal(outcome.history[0].resultType, 'complete');
});

test('mrtr: needs_input round — handler answer becomes the follow-up', async () => {
  const transport = scriptedTransport([
    buildMrtrResult('needs_input', { need: { prompt: 'Need a path.' }, roundTripId: 'rt-7' }),
    (method, params) => {
      assert.equal(params['answer']['path'], '/workspace/notes.md');
      assert.equal(params['_meta']['roundTrip']['roundTripId'], 'rt-7');
      assert.equal(params['_meta']['roundTrip']['round'], 2);
      // The accumulated answers travel so any server instance can resume.
      assert.deepEqual(params['previousAnswers']['round1'], { path: '/workspace/notes.md' });
      return { resultType: 'complete', result: 'file read' };
    },
  ]);
  const outcome = await runMultiRoundTrip(
    transport,
    'tools/call',
    { name: 'read_file', arguments: {} },
    { onNeedsInput: async () => ({ path: '/workspace/notes.md' }) },
  );
  assert.equal(outcome.result, 'file read');
  assert.equal(outcome.rounds, 2);
  assert.equal(outcome.roundTripId, 'rt-7');
});

test('mrtr: needs_sampling + needs_elicitation + needs_roots chain in order', async () => {
  const seen = [];
  const transport = scriptedTransport([
    buildMrtrResult('needs_sampling', { need: { prompt: 'Summarize.' } }),
    buildMrtrResult('needs_elicitation', { need: { prompt: 'Your name?' } }),
    buildMrtrResult('needs_roots', { need: { prompt: 'Which workspace?' } }),
    { resultType: 'complete', result: 'all rounds done' },
  ]);
  const outcome = await runMultiRoundTrip(
    transport,
    'tools/call',
    { name: 'complex' },
    {
      onNeedsSampling: async (need) => {
        seen.push(`sampling:${need.prompt}`);
        return 'summary text';
      },
      onNeedsElicitation: async () => {
        seen.push('elicitation');
        return { name: 'Huy' };
      },
      onNeedsRoots: async () => {
        seen.push('roots');
        return [{ uri: 'file:///workspace' }];
      },
      onRound: (record) => seen.push(`round${record.round}:${record.resultType}`),
    },
  );
  assert.equal(outcome.result, 'all rounds done');
  assert.equal(outcome.rounds, 4);
  assert.deepEqual(seen, [
    'round1:needs_sampling',
    'sampling:Summarize.',
    'round2:needs_elicitation',
    'elicitation',
    'round3:needs_roots',
    'roots',
    'round4:complete',
  ]);
});

test('mrtr: missing handler fails loudly instead of inventing an answer', async () => {
  const transport = scriptedTransport([
    buildMrtrResult('needs_elicitation', { need: { prompt: 'Secret?' } }),
  ]);
  await assert.rejects(
    () => runMultiRoundTrip(transport, 'tools/call', { name: 'ask' }, {}),
    (err) => err instanceof MrtrError && /onNeedsElicitation/.test(err.message),
  );
  // resolveMrtrNeed directly: every kind without a handler throws.
  for (const kind of MRTR_FOLLOW_UP_TYPES) {
    await assert.rejects(() => resolveMrtrNeed({ resultType: kind }, 1, {}), MrtrError);
  }
});

test('mrtr: needs_confirmation false aborts the call', async () => {
  const transport = scriptedTransport([
    buildMrtrResult('needs_confirmation', { need: { prompt: 'Delete everything?' } }),
    { resultType: 'complete', result: 'should never arrive' },
  ]);
  await assert.rejects(
    () =>
      runMultiRoundTrip(
        transport,
        'tools/call',
        { name: 'delete_all' },
        { onNeedsConfirmation: async () => false },
      ),
    (err) => err instanceof MrtrError && /từ chối/.test(err.message),
  );
  assert.equal(transport.calls.length, 1);
});

test('mrtr: needs_confirmation true continues to the next round', async () => {
  const transport = scriptedTransport([
    buildMrtrResult('needs_confirmation', { need: { prompt: 'Proceed?' } }),
    { resultType: 'complete', result: 'proceeded' },
  ]);
  const outcome = await runMultiRoundTrip(
    transport,
    'tools/call',
    { name: 'risky' },
    { onNeedsConfirmation: async () => true },
  );
  assert.equal(outcome.result, 'proceeded');
  assert.equal(outcome.rounds, 2);
});

test('mrtr: maxRounds stops a server that keeps asking', async () => {
  const endless = () =>
    buildMrtrResult('needs_input', { need: { prompt: 'More?' } });
  const transport = scriptedTransport([endless, endless, endless, endless]);
  await assert.rejects(
    () =>
      runMultiRoundTrip(
        transport,
        'tools/call',
        { name: 'greedy' },
        { onNeedsInput: async () => ({ more: true }) },
        { maxRounds: 3 },
      ),
    (err) => err instanceof MrtrError && /vượt quá 3 round/.test(err.message),
  );
  assert.equal(transport.calls.length, 3);
  await assert.rejects(
    runMultiRoundTrip(scriptedTransport([]), 'tools/call', {}, {}, { maxRounds: 0 }),
    /maxRounds phải >= 1/,
  );
});

test('mrtr: maxRounds of 1 rejects a multi-round server on the first follow-up', async () => {
  const transport = scriptedTransport([
    buildMrtrResult('needs_input', { need: { prompt: 'More?' } }),
  ]);
  const promise = runMultiRoundTrip(
    transport,
    'tools/call',
    { name: 'x' },
    { onNeedsInput: async () => ({}) },
    { maxRounds: 1 },
  );
  await assert.rejects(promise, /vượt quá 1 round/);
});
