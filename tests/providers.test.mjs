/**
 * Tests for the OpenAI-compatible provider transport
 * (packages/core/src/providers/openaiCompatible.ts).
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/providers.test.mjs
 *
 * No real API key and no network: global fetch is stubbed.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { openAIChatCompletions } from '../packages/core/dist/providers/openaiCompatible.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.OPEN_BOT_FETCH_TIMEOUT_MS;
});

const req = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
};

test('provider chat: hanging fetch aborts after the configured timeout', async () => {
  process.env.OPEN_BOT_FETCH_TIMEOUT_MS = '50';
  // A fetch that never settles on its own but rejects when aborted —
  // this is what undici does when AbortSignal.timeout fires.
  globalThis.fetch = (_url, opts) =>
    new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => {
        const err = new Error('The operation timed out.');
        err.name = 'TimeoutError';
        reject(err);
      });
    });
  const started = Date.now();
  await assert.rejects(
    () => openAIChatCompletions('https://example.invalid/v1', undefined, 'Test', req),
    /hết thời gian chờ phản hồi sau 50ms/,
  );
  assert.ok(Date.now() - started < 5000, 'timeout must fire quickly, not hang');
});

test('provider chat: HTTP error surfaces with status', async () => {
  globalThis.fetch = async () =>
    new Response('{"error":{"message":"bad key"}}', { status: 401, statusText: 'Unauthorized' });
  await assert.rejects(
    () => openAIChatCompletions('https://example.invalid/v1', undefined, 'Test', req),
    /Test: HTTP 401/,
  );
});

test('provider chat: valid response parses text + tool calls', async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: 'hello',
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'echo', arguments: '{"text":"hi"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: 200 },
    );
  const res = await openAIChatCompletions('https://example.invalid/v1', undefined, 'Test', req);
  assert.equal(res.text, 'hello');
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].name, 'echo');
  assert.deepEqual(res.usage, { inputTokens: 10, outputTokens: 5 });
});
