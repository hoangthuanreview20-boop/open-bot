/**
 * Tests cho v0.15 item 7 — provider abort signal
 * (packages/core/src/providers/abort.ts + signal trong ChatCompletionRequest).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/provider-abort-v015.test.mjs
 *
 * Không cần API key thật, không gọi mạng thật: global fetch được stub.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createAbortController,
  isAbortError,
  throwIfAborted,
  withTimeout,
} from '../packages/core/dist/providers/abort.js';
import { openAIChatCompletions } from '../packages/core/dist/providers/openaiCompatible.js';
import { createProvider } from '../packages/core/dist/providers/index.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.OPEN_BOT_FETCH_TIMEOUT_MS;
});

const baseReq = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
};

function okResponse() {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { status: 200 },
  );
}

/** Fetch treo mãi, chỉ reject (AbortError) khi signal của nó bị hủy. */
function hangingFetchStub() {
  return (_url, opts) =>
    new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted.');
        err.name = 'AbortError';
        reject(err);
      });
    });
}

test('abort helper: createAbortController + throwIfAborted', () => {
  const c = createAbortController();
  assert.ok(c instanceof AbortController);
  assert.equal(c.signal.aborted, false);
  // Không có signal / chưa hủy → không ném.
  assert.doesNotThrow(() => throwIfAborted(undefined));
  assert.doesNotThrow(() => throwIfAborted(c.signal));
  c.abort();
  assert.throws(() => throwIfAborted(c.signal), (err) => {
    assert.equal(err.name, 'AbortError');
    assert.match(err.message, /Đã hủy yêu cầu provider/);
    assert.equal(isAbortError(err), true);
    return true;
  });
  assert.equal(isAbortError(new Error('lỗi khác')), false);
  assert.equal(isAbortError(undefined), false);
});

test('abort helper: withTimeout gộp signal + timeout', async () => {
  // Không có ms → trả lại đúng signal gốc.
  const c1 = createAbortController();
  const r1 = withTimeout(c1.signal, undefined);
  assert.equal(r1.signal, c1.signal);
  r1.dispose();

  // Có ms → hủy khi hết timeout, kể cả khi signal gốc chưa hủy.
  const c2 = createAbortController();
  const r2 = withTimeout(c2.signal, 50);
  assert.equal(r2.signal.aborted, false);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(r2.signal.aborted, true);
  r2.dispose();

  // dispose() trước hạn → timeout không kích hoạt nữa.
  const r3 = withTimeout(undefined, 50);
  r3.dispose();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(r3.signal?.aborted, false);

  // Signal gốc đã hủy sẵn → signal gộp hủy ngay, không chờ timer.
  const c4 = createAbortController();
  c4.abort();
  const r4 = withTimeout(c4.signal, 5000);
  assert.equal(r4.signal?.aborted, true);
  r4.dispose();
});

test('provider chat: signal đã hủy trước khi gọi → reject ngay, không fetch', async () => {
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return okResponse();
  };
  const c = createAbortController();
  c.abort();
  await assert.rejects(
    () => openAIChatCompletions('https://example.invalid/v1', undefined, 'Test', { ...baseReq, signal: c.signal }),
    /đã hủy/i,
  );
  assert.equal(fetchCalled, false, 'không được gọi fetch khi đã hủy trước');
});

test('provider chat: hủy giữa chừng → reject nhanh, không treo', async () => {
  globalThis.fetch = hangingFetchStub();
  const c = createAbortController();
  setTimeout(() => c.abort(), 50);
  const started = Date.now();
  await assert.rejects(
    () => openAIChatCompletions('https://example.invalid/v1', undefined, 'Test', { ...baseReq, signal: c.signal }),
    /đã hủy yêu cầu khi đang chờ phản hồi/,
  );
  assert.ok(Date.now() - started < 5000, 'abort giữa chừng phải reject nhanh, không treo');
});

test('provider chat: không có signal → chạy bình thường (backward compatible)', async () => {
  let sawSignal;
  globalThis.fetch = async (_url, opts) => {
    sawSignal = opts?.signal;
    return okResponse();
  };
  const res = await openAIChatCompletions('https://example.invalid/v1', undefined, 'Test', baseReq);
  assert.equal(res.text, 'hello');
  // Không có signal người gọi thì signal truyền xuống fetch chỉ còn là
  // timeout nội bộ — vẫn có signal (để timeout hoạt động), nhưng fetch
  // hoàn thành bình thường.
  assert.ok(sawSignal instanceof AbortSignal);
  assert.equal(sawSignal.aborted, false);
});

test('OpenAIProvider (qua createProvider): hủy giữa chừng → reject', async () => {
  globalThis.fetch = hangingFetchStub();
  const provider = createProvider({
    id: 'openai',
    label: 'OpenAI',
    apiKey: 'test-key',
    defaultModel: 'gpt-5-mini',
  });
  const c = createAbortController();
  setTimeout(() => c.abort(), 50);
  const started = Date.now();
  await assert.rejects(
    () => provider.chat({ ...baseReq, signal: c.signal }),
    /đã hủy yêu cầu khi đang chờ phản hồi/,
  );
  assert.ok(Date.now() - started < 5000);
});

test('OllamaProvider (qua createProvider): hủy giữa chừng → reject', async () => {
  globalThis.fetch = hangingFetchStub();
  const provider = createProvider({
    id: 'ollama',
    label: 'Ollama (local)',
    defaultModel: 'llama3.1',
  });
  const c = createAbortController();
  setTimeout(() => c.abort(), 50);
  const started = Date.now();
  await assert.rejects(
    () => provider.chat({ ...baseReq, signal: c.signal }),
    /đã hủy yêu cầu khi đang chờ phản hồi/,
  );
  assert.ok(Date.now() - started < 5000);
});

test('createProvider wrapper: signal đã hủy → reject ngay cả với provider chưa nối fetch', async () => {
  // Wrapper chung ở createProvider vẫn chặn được trước khi gọi — chứng
  // minh bằng config không có apiKey: lỗi phải là "đã hủy", không phải
  // lỗi "chưa cấu hình API key", và fetch không được gọi. (Anthropic từ
  // W12b đã nối signal xuống fetch; test này chứng minh riêng lớp wrapper
  // chặn trước khi vào provider.)
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return okResponse();
  };
  const provider = createProvider({ id: 'anthropic', label: 'Anthropic', defaultModel: 'x' });
  const c = createAbortController();
  c.abort();
  await assert.rejects(
    () => provider.chat({ ...baseReq, signal: c.signal }),
    /Đã hủy yêu cầu provider/,
  );
  assert.equal(fetchCalled, false);
});

// ---------------------------------------------------------------------------
// Loop wiring (điều phối viên nối): signal xuống provider + kiểm tra mỗi step
// ---------------------------------------------------------------------------
import { AgentRunner } from '../packages/core/dist/agent/loop.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Provider treo mãi, chỉ reject khi signal trong req bị hủy. */
function hangingProvider(chatCalls) {
  return {
    id: 'mock',
    label: 'Mock',
    async chat(req) {
      chatCalls.push(req);
      if (req.signal?.aborted) {
        const err = new Error('Đã hủy yêu cầu provider (abort signal).');
        err.name = 'AbortError';
        throw err;
      }
      await new Promise((_resolve, reject) => {
        req.signal?.addEventListener('abort', () => {
          const err = new Error('Đã hủy yêu cầu provider (abort signal).');
          err.name = 'AbortError';
          reject(err);
        });
      });
    },
    async listModels() {
      return ['mock'];
    },
  };
}

function makeLoopBot() {
  return {
    id: 'bot-abort',
    name: 'Abort Test',
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'You are a test bot.',
    workspaceDir: process.cwd(),
    autoApprove: true,
  };
}

function makeLoopEvents() {
  return {
    onText: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onApprovalNeeded: async () => true,
  };
}

/** Race với timeout để test fail rõ thay vì treo mãi nếu wiring bị hỏng. */
async function withTestTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`test timeout (${ms}ms) — ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('loop: signal đã hủy trước khi chạy → run reject ngay, provider không được gọi', async () => {
  const chatCalls = [];
  const provider = hangingProvider(chatCalls);
  const c = createAbortController();
  c.abort();
  const runner = new AgentRunner(provider, [], {
    bot: makeLoopBot(),
    events: makeLoopEvents(),
    signal: c.signal,
  });
  await assert.rejects(() => withTestTimeout(runner.run('hello'), 5000, 'abort trước khi chạy'), (err) => {
    assert.ok(isAbortError(err), `phải là AbortError, got ${err?.name}: ${err?.message}`);
    return true;
  });
  assert.equal(chatCalls.length, 0, 'provider.chat không được gọi khi signal đã hủy');
});

test('loop: abort giữa chừng → lần fetch đang chờ bị hủy, run reject nhanh', async () => {
  const chatCalls = [];
  const provider = hangingProvider(chatCalls);
  const c = createAbortController();
  const runner = new AgentRunner(provider, [], {
    bot: makeLoopBot(),
    events: makeLoopEvents(),
    signal: c.signal,
  });
  setTimeout(() => c.abort(), 50);
  const started = Date.now();
  await assert.rejects(() => withTestTimeout(runner.run('hello'), 5000, 'abort giữa chừng'), (err) => {
    assert.ok(isAbortError(err), `phải là AbortError, got ${err?.name}: ${err?.message}`);
    return true;
  });
  assert.ok(Date.now() - started < 2000, 'run phải dừng nhanh sau abort, không chờ fetch treo');
  assert.equal(chatCalls.length, 1);
});

test('loop: abort trong lúc chạy tool → không bắt đầu step provider mới', async () => {
  let chatCount = 0;
  const slowTool = {
    definition: {
      name: 'slow_tool',
      description: 'Tool chậm để test abort giữa step.',
      parameters: { type: 'object', properties: {} },
    },
    needsApproval: false,
    execute: async () => {
      await sleep(120);
      return 'tool xong';
    },
  };
  const provider = {
    id: 'mock',
    label: 'Mock',
    async chat(req) {
      chatCount += 1;
      if (chatCount === 1) {
        return { text: '', toolCalls: [{ id: 'c1', name: 'slow_tool', args: {} }] };
      }
      // Step 2 phải không bao giờ tới (abort đã xảy ra trong lúc chạy tool).
      return { text: 'không được gọi', toolCalls: [] };
    },
    async listModels() {
      return ['mock'];
    },
  };
  const c = createAbortController();
  const runner = new AgentRunner(provider, [slowTool], {
    bot: makeLoopBot(),
    events: makeLoopEvents(),
    signal: c.signal,
  });
  setTimeout(() => c.abort(), 30);
  await assert.rejects(() => withTestTimeout(runner.run('làm việc chậm'), 5000, 'abort giữa step'), (err) => {
    assert.ok(isAbortError(err), `phải là AbortError, got ${err?.name}: ${err?.message}`);
    return true;
  });
  assert.equal(chatCount, 1, 'abort trong lúc chạy tool thì step provider thứ 2 không được gọi');
});

// ---------------------------------------------------------------------------
// W12b — Anthropic + Gemini: nối signal mid-flight xuống fetch
// (trước đây chỉ có pre-call check qua wrapper ở createProvider; fetch
// trần chạy hết dù đã abort). Test bằng mock fetch, không mạng thật.
// ---------------------------------------------------------------------------
import { AnthropicProvider } from '../packages/core/dist/providers/anthropic.js';
import { GeminiProvider } from '../packages/core/dist/providers/gemini.js';

function anthropicOkResponse() {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text: 'hello' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    { status: 200 },
  );
}

function geminiOkResponse() {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'hello' }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    }),
    { status: 200 },
  );
}

const abortWiredProviders = [
  {
    name: 'AnthropicProvider',
    makeProvider: () =>
      new AnthropicProvider({ id: 'anthropic', label: 'Anthropic', apiKey: 'test-key', defaultModel: 'claude-sonnet-4-5' }),
    okResponse: anthropicOkResponse,
    viaCreateProvider: () =>
      createProvider({ id: 'anthropic', label: 'Anthropic', apiKey: 'test-key', defaultModel: 'claude-sonnet-4-5' }),
  },
  {
    name: 'GeminiProvider',
    makeProvider: () =>
      new GeminiProvider({ id: 'gemini', label: 'Gemini', apiKey: 'test-key', defaultModel: 'gemini-2.5-flash' }),
    okResponse: geminiOkResponse,
    viaCreateProvider: () =>
      createProvider({ id: 'gemini', label: 'Gemini', apiKey: 'test-key', defaultModel: 'gemini-2.5-flash' }),
  },
];

for (const { name, makeProvider, okResponse, viaCreateProvider } of abortWiredProviders) {
  test(`${name}: hủy giữa chừng → reject với AbortError, message tiếng Việt`, async () => {
    globalThis.fetch = hangingFetchStub();
    const provider = makeProvider();
    const c = createAbortController();
    setTimeout(() => c.abort(), 50);
    const started = Date.now();
    await assert.rejects(
      () => provider.chat({ ...baseReq, signal: c.signal }),
      (err) => {
        assert.equal(isAbortError(err), true, `phải là AbortError, got ${err?.name}: ${err?.message}`);
        assert.match(err.message, /đã hủy yêu cầu khi đang chờ phản hồi/);
        return true;
      },
    );
    assert.ok(Date.now() - started < 5000, 'abort giữa chừng phải reject nhanh, không treo');
  });

  test(`${name}: abort trước khi gọi → reject ngay, không fetch`, async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return okResponse();
    };
    const provider = makeProvider();
    const c = createAbortController();
    c.abort();
    await assert.rejects(
      () => provider.chat({ ...baseReq, signal: c.signal }),
      (err) => {
        assert.equal(isAbortError(err), true, `phải là AbortError, got ${err?.name}: ${err?.message}`);
        assert.match(err.message, /Đã hủy yêu cầu provider/);
        return true;
      },
    );
    assert.equal(fetchCalled, false, 'không được gọi fetch khi đã hủy trước');
  });

  test(`${name}: fetch bình thường không signal → chạy như cũ`, async () => {
    let sawSignal = 'chưa-gọi';
    globalThis.fetch = async (_url, opts) => {
      sawSignal = opts?.signal;
      return okResponse();
    };
    const provider = makeProvider();
    const res = await provider.chat(baseReq);
    assert.equal(res.text, 'hello');
    // W13d: giờ có timeout nội bộ 5 phút dùng chung với họ
    // OpenAI-compatible nên fetch luôn nhận một signal (timeout) kể cả
    // khi không có signal người gọi — fetch nhanh vẫn chạy như cũ.
    assert.ok(sawSignal instanceof AbortSignal);
    assert.equal(sawSignal.aborted, false);
  });

  test(`${name} (qua createProvider): hủy giữa chừng → reject với AbortError`, async () => {
    globalThis.fetch = hangingFetchStub();
    const provider = viaCreateProvider();
    const c = createAbortController();
    setTimeout(() => c.abort(), 50);
    const started = Date.now();
    await assert.rejects(
      () => provider.chat({ ...baseReq, signal: c.signal }),
      (err) => {
        assert.equal(isAbortError(err), true, `phải là AbortError, got ${err?.name}: ${err?.message}`);
        assert.match(err.message, /đã hủy yêu cầu khi đang chờ phản hồi/);
        return true;
      },
    );
    assert.ok(Date.now() - started < 5000);
  });
}

// ---------------------------------------------------------------------------
// W13d — Anthropic + Gemini: timeout nội bộ 5 phút (gap W12b để lại)
// Trước đây hai provider này truyền thẳng req.signal xuống fetch, không có
// timeout nội bộ: fetch treo thì treo tới khi mạng/OS ngắt. Giờ gộp
// req.signal với timeout dùng chung chatFetchTimeoutMs() (mặc định 5 phút,
// override bằng env OPEN_BOT_FETCH_TIMEOUT_MS như họ OpenAI-compatible).
// Test bằng mock fetch treo + timeout ngắn qua env, KHÔNG chờ 5 phút thật.
// ---------------------------------------------------------------------------
for (const { name, makeProvider, okResponse } of abortWiredProviders) {
  test(`${name} (W13d): fetch treo + timeout ngắn, không signal → lỗi timeout tiếng Việt, KHÔNG phải AbortError`, async () => {
    process.env.OPEN_BOT_FETCH_TIMEOUT_MS = '50';
    globalThis.fetch = hangingFetchStub();
    const provider = makeProvider();
    const started = Date.now();
    await assert.rejects(
      () => provider.chat(baseReq),
      (err) => {
        assert.equal(isAbortError(err), false, `hết timeout không được là AbortError, got ${err?.name}: ${err?.message}`);
        assert.notEqual(err.name, 'AbortError');
        assert.match(err.message, /hết thời gian chờ phản hồi sau 50ms/);
        return true;
      },
    );
    assert.ok(Date.now() - started < 5000, 'timeout phải reject nhanh, không treo');
  });

  test(`${name} (W13d): fetch treo + timeout ngắn, có signal chưa hủy → lỗi timeout, KHÔNG phải AbortError`, async () => {
    process.env.OPEN_BOT_FETCH_TIMEOUT_MS = '50';
    globalThis.fetch = hangingFetchStub();
    const provider = makeProvider();
    const c = createAbortController(); // chưa hủy — chỉ timeout mới kích hoạt
    const started = Date.now();
    await assert.rejects(
      () => provider.chat({ ...baseReq, signal: c.signal }),
      (err) => {
        assert.equal(isAbortError(err), false, `hết timeout không được là AbortError, got ${err?.name}: ${err?.message}`);
        assert.match(err.message, /hết thời gian chờ phản hồi sau 50ms/);
        return true;
      },
    );
    assert.ok(Date.now() - started < 5000);
    assert.equal(c.signal.aborted, false, 'signal gốc vẫn chưa hủy — chỉ timeout nội bộ kích hoạt');
  });

  test(`${name} (W13d): hủy trước timeout → AbortError, KHÔNG phải lỗi timeout`, async () => {
    process.env.OPEN_BOT_FETCH_TIMEOUT_MS = '5000';
    globalThis.fetch = hangingFetchStub();
    const provider = makeProvider();
    const c = createAbortController();
    setTimeout(() => c.abort(), 50);
    const started = Date.now();
    await assert.rejects(
      () => provider.chat({ ...baseReq, signal: c.signal }),
      (err) => {
        assert.equal(isAbortError(err), true, `hủy trước timeout phải là AbortError, got ${err?.name}: ${err?.message}`);
        assert.match(err.message, /đã hủy yêu cầu khi đang chờ phản hồi/);
        assert.doesNotMatch(err.message, /hết thời gian chờ/);
        return true;
      },
    );
    assert.ok(Date.now() - started < 2000, 'hủy trước timeout phải reject nhanh, không chờ hết timeout');
  });

  test(`${name} (W13d): fetch nhanh với signal → chạy bình thường, signal gộp chưa hủy`, async () => {
    let sawSignal;
    globalThis.fetch = async (_url, opts) => {
      sawSignal = opts?.signal;
      return okResponse();
    };
    const provider = makeProvider();
    const c = createAbortController();
    const res = await provider.chat({ ...baseReq, signal: c.signal });
    assert.equal(res.text, 'hello');
    assert.ok(sawSignal instanceof AbortSignal);
    assert.equal(sawSignal.aborted, false);
  });
}
