/**
 * Tests cho W5b (v0.13 mục 4, 5, 8): MCP elicitation + tasks + prompts/
 * resources subscribe/templates + completion (node:test, không mạng live).
 *
 * Import package core ĐÃ BUILD — build riêng core trước:
 *   npx tsc -p packages/core/tsconfig.json
 * rồi chạy: node --test tests/mcp-elicitation-tasks-v013.test.mjs
 * Mọi transport/server đều là giả lập trong file (FakeTransport).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ElicitationError,
  ElicitationUrlTracker,
  createElicitationHandler,
  handleElicitationRequest,
  isSensitiveElicitationField,
  parseElicitationCompleteNotification,
  parseElicitationRequest,
  parseElicitationSchema,
  validateElicitedContent,
} from '../packages/core/dist/mcp/elicitation.js';
import {
  TaskError,
  TaskHandle,
  createTask,
  listTasks,
  parseTaskHandle,
  parseTaskStatus,
  runTaskToCompletion,
} from '../packages/core/dist/mcp/tasks.js';
import {
  PromptsError,
  ResourceWatcher,
  completePromptArgument,
  completeResourceArgument,
  getPrompt,
  listPrompts,
  listResourceTemplates,
  onResourcesUpdated,
  subscribeResource,
  unsubscribeResource,
  validatePromptArguments,
} from '../packages/core/dist/mcp/prompts.js';

/** Transport giả: handler script theo method, ghi lại mọi call, phát được notification. */
class FakeTransport {
  constructor(handler) {
    this.handler = handler;
    this.calls = [];
    this.notifHandlers = new Set();
  }

  async request(method, params) {
    this.calls.push({ method, params });
    return this.handler(method, params, this.calls.length);
  }

  onNotification(handler) {
    this.notifHandlers.add(handler);
    return () => {
      this.notifHandlers.delete(handler);
    };
  }

  emit(method, params) {
    for (const handler of [...this.notifHandlers]) handler(method, params);
  }

  called(method) {
    return this.calls.filter((c) => c.method === method);
  }
}

// --- Elicitation: parse ------------------------------------------------------

const FORM_SCHEMA = {
  type: 'object',
  properties: {
    city: { type: 'string', title: 'City', enum: ['Hanoi', 'Saigon'], default: 'Hanoi' },
    days: { type: 'integer', minimum: 1, maximum: 30, default: 3 },
    budget: { type: 'number', minimum: 0 },
    vip: { type: 'boolean', default: false },
    tags: { type: 'array', items: { type: 'string', enum: ['beach', 'food', 'history'] } },
  },
  required: ['city', 'days'],
};

test('elicitation: parse form-mode — field đủ loại, enum, default, required', () => {
  const req = parseElicitationRequest(
    { message: 'Where to?', requestedSchema: FORM_SCHEMA },
    'travel-server',
  );
  assert.equal(req.mode, 'form');
  assert.equal(req.serverName, 'travel-server');
  assert.equal(req.message, 'Where to?');
  assert.equal(req.fields.length, 5);
  const byName = Object.fromEntries(req.fields.map((f) => [f.name, f]));
  assert.equal(byName.city.type, 'string');
  assert.deepEqual(byName.city.enum, ['Hanoi', 'Saigon']);
  assert.equal(byName.city.default, 'Hanoi');
  assert.equal(byName.city.required, true);
  assert.equal(byName.days.type, 'integer');
  assert.equal(byName.days.required, true);
  assert.equal(byName.budget.required, false);
  assert.equal(byName.tags.type, 'string-array');
  assert.deepEqual(byName.tags.enum, ['beach', 'food', 'history']);
});

test('elicitation: parse — thiếu requestedSchema ở form-mode thì lỗi', () => {
  assert.throws(
    () => parseElicitationRequest({ message: 'Hi' }, 's'),
    (e) => e instanceof ElicitationError && /requestedSchema/.test(e.message),
  );
});

test('elicitation: parse — schema sai hình dạng thì lỗi', () => {
  assert.throws(
    () => parseElicitationSchema({ type: 'object', properties: { nested: { type: 'object', properties: {} } } }),
    (e) => e instanceof ElicitationError && /không hỗ trợ/.test(e.message),
  );
  assert.throws(
    () => parseElicitationSchema({ type: 'array' }),
    (e) => e instanceof ElicitationError && /"object"/.test(e.message),
  );
  assert.throws(
    () => parseElicitationSchema('not-an-object'),
    (e) => e instanceof ElicitationError,
  );
});

test('elicitation: parse — field nhạy cảm (password / apiKey) bị từ chối', () => {
  assert.equal(isSensitiveElicitationField('password', { type: 'string' }), true);
  assert.equal(isSensitiveElicitationField('apiKey', { type: 'string' }), true);
  assert.equal(isSensitiveElicitationField('city', { type: 'string' }), false);
  assert.throws(
    () =>
      parseElicitationSchema({
        type: 'object',
        properties: { password: { type: 'string', format: 'password' } },
      }),
    (e) => e instanceof ElicitationError && /nhạy cảm/.test(e.message),
  );
  assert.throws(
    () =>
      parseElicitationSchema({
        type: 'object',
        properties: { api_key: { type: 'string' } },
      }),
    (e) => e instanceof ElicitationError && /nhạy cảm/.test(e.message),
  );
});

test('elicitation: parse URL-mode — ok, thiếu URL hoặc URL lạ thì lỗi', () => {
  const req = parseElicitationRequest(
    { message: 'Sign in', mode: 'url', url: 'https://example.com/auth', elicitationId: 'e-1' },
    'auth-server',
  );
  assert.equal(req.mode, 'url');
  assert.equal(req.url, 'https://example.com/auth');
  assert.equal(req.elicitationId, 'e-1');
  assert.equal(req.fields, undefined);
  assert.throws(
    () => parseElicitationRequest({ message: 'x', mode: 'url' }, 's'),
    (e) => e instanceof ElicitationError && /url/.test(e.message),
  );
  assert.throws(
    () => parseElicitationRequest({ message: 'x', mode: 'url', url: 'ftp://example.com/a' }, 's'),
    (e) => e instanceof ElicitationError,
  );
  assert.throws(
    () => parseElicitationRequest({ message: 'x', mode: 'weird' }, 's'),
    (e) => e instanceof ElicitationError && /mode/.test(e.message),
  );
});

// --- Elicitation: validate --------------------------------------------------

test('elicitation: validate — áp default, ép số từ chuỗi, loại key lạ', () => {
  const fields = parseElicitationSchema(FORM_SCHEMA);
  const out = validateElicitedContent(fields, {
    city: 'Saigon',
    days: '7',
    tags: ['food'],
    unknownKey: 'drop me',
  });
  assert.deepEqual(out, { city: 'Saigon', days: 7, vip: false, tags: ['food'] });
  assert.equal(out.days, 7);
  assert.equal(out.vip, false); // default
  assert.equal('unknownKey' in out, false);
  assert.equal('budget' in out, false); // không required, không default -> vắng
});

test('elicitation: validate — thiếu required / sai enum / sai số / ngoài khoảng', () => {
  const fields = parseElicitationSchema(FORM_SCHEMA);
  // "city"/"days" đều có default nên vắng vẫn hợp lệ; dùng schema riêng
  // cho trường hợp thiếu required không có default.
  const requiredFields = parseElicitationSchema({
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  });
  assert.throws(
    () => validateElicitedContent(requiredFields, {}),
    (e) => e instanceof ElicitationError && /"name" là bắt buộc/.test(e.message),
  );
  assert.throws(
    () => validateElicitedContent(fields, { city: 'Paris', days: 2 }),
    (e) => e instanceof ElicitationError && /một trong/.test(e.message),
  );
  assert.throws(
    () => validateElicitedContent(fields, { city: 'Hanoi', days: 'abc' }),
    (e) => e instanceof ElicitationError && /phải là một số/.test(e.message),
  );
  assert.throws(
    () => validateElicitedContent(fields, { city: 'Hanoi', days: 99 }),
    (e) => e instanceof ElicitationError && /<= 30/.test(e.message),
  );
  assert.throws(
    () => validateElicitedContent(fields, { city: 'Hanoi', days: 2, tags: ['nope'] }),
    (e) => e instanceof ElicitationError && /ngoài enum/.test(e.message),
  );
});

// --- Elicitation: handler + URL tracker --------------------------------------

test('elicitation: handle — accept validate lại, null -> cancel, decline giữ nguyên', async () => {
  const req = parseElicitationRequest({ message: 'Where?', requestedSchema: FORM_SCHEMA }, 's');
  const accepted = await handleElicitationRequest(req, async () => ({
    action: 'accept',
    content: { city: 'Saigon', days: '5' },
  }));
  assert.equal(accepted.action, 'accept');
  assert.equal(accepted.content.days, 5);
  assert.equal(accepted.content.vip, false);

  const cancelled = await handleElicitationRequest(req, async () => null);
  assert.deepEqual(cancelled, { action: 'cancel' });

  const declined = await handleElicitationRequest(req, async () => ({ action: 'decline' }));
  assert.deepEqual(declined, { action: 'decline' });

  // Signal abort trước khi hỏi -> cancel, không gọi prompt.
  const controller = new AbortController();
  controller.abort();
  let prompted = false;
  const aborted = await handleElicitationRequest(
    req,
    async () => {
      prompted = true;
      return { action: 'accept', content: {} };
    },
    { signal: controller.signal },
  );
  assert.deepEqual(aborted, { action: 'cancel' });
  assert.equal(prompted, false);
});

test('elicitation: createElicitationHandler — parse + hỏi user trong một hàm', async () => {
  const handler = createElicitationHandler(async (request) => {
    assert.equal(request.serverName, 'travel-server');
    return { action: 'accept', content: { city: 'Hanoi', days: 2 } };
  });
  const result = await handler({ message: 'Where?', requestedSchema: FORM_SCHEMA }, 'travel-server');
  assert.equal(result.action, 'accept');
  assert.equal(result.content.city, 'Hanoi');
});

test('elicitation: UrlTracker — chờ complete, complete id lạ, cancelAll, timeout', async () => {
  const tracker = new ElicitationUrlTracker();
  assert.equal(tracker.pendingCount, 0);
  assert.equal(tracker.complete('no-such-id'), false);

  const waiting = tracker.waitForCompletion('e-9');
  assert.equal(tracker.pendingCount, 1);
  assert.throws(
    () => tracker.waitForCompletion('e-9'),
    (e) => e instanceof ElicitationError && /đã có lượt chờ/.test(e.message),
  );
  assert.equal(tracker.complete('e-9'), true);
  await waiting;
  assert.equal(tracker.pendingCount, 0);

  // cancelAll reject lượt chờ.
  const p1 = tracker.waitForCompletion('e-10');
  const p2 = tracker.waitForCompletion('e-11');
  tracker.cancelAll();
  await assert.rejects(p1, (e) => e instanceof ElicitationError && /huỷ/.test(e.message));
  await assert.rejects(p2, (e) => e instanceof ElicitationError);

  // Hết timeout.
  await assert.rejects(
    tracker.waitForCompletion('e-12', { timeoutMs: 10 }),
    (e) => e instanceof ElicitationError && /hết thời gian/.test(e.message),
  );

  // parse notification complete.
  assert.equal(
    parseElicitationCompleteNotification('notifications/elicitation/complete', { elicitationId: 'e-1' }),
    'e-1',
  );
  assert.equal(parseElicitationCompleteNotification('notifications/progress', {}), null);
  assert.equal(
    parseElicitationCompleteNotification('notifications/elicitation/complete', {}),
    null,
  );
});

// --- Tasks: parse ------------------------------------------------------------

test('tasks: parseTaskStatus / parseTaskHandle — đủ trạng thái spec, sai thì lỗi', () => {
  for (const status of ['working', 'input_required', 'completed', 'failed', 'cancelled']) {
    assert.equal(parseTaskStatus(status), status);
  }
  assert.throws(() => parseTaskStatus('done'), (e) => e instanceof TaskError);
  assert.throws(() => parseTaskStatus(undefined), (e) => e instanceof TaskError);

  const handle = parseTaskHandle({ taskId: 't1', status: 'working', pollInterval: 250 });
  assert.equal(handle.taskId, 't1');
  assert.equal(handle.pollInterval, 250);
  assert.throws(() => parseTaskHandle({ status: 'working' }), (e) => e instanceof TaskError);
  assert.throws(
    () => parseTaskHandle({ taskId: 't1', status: 'bogus' }),
    (e) => e instanceof TaskError,
  );
  // pollInterval không hợp lệ -> bỏ qua, không fail.
  assert.equal(parseTaskHandle({ taskId: 't1', status: 'working', pollInterval: -5 }).pollInterval, undefined);
});

// --- Tasks: chạy task --------------------------------------------------------

function workingThenDoneTransport(result) {
  let gets = 0;
  const transport = new FakeTransport((method) => {
    if (method === 'tools/call') return { taskId: 't1', status: 'working', pollInterval: 5 };
    if (method === 'tasks/get') {
      gets += 1;
      return gets < 3 ? { taskId: 't1', status: 'working', pollInterval: 5 } : { taskId: 't1', status: 'completed' };
    }
    if (method === 'tasks/result') return result;
    if (method === 'tasks/cancel') return { taskId: 't1', status: 'cancelled' };
    throw new Error(`unexpected method ${method}`);
  });
  return { transport, getGets: () => gets };
}

test('tasks: createTask gửi _meta.task, waitForCompletion poll rồi lấy result', async () => {
  const { transport, getGets } = workingThenDoneTransport({ content: [{ type: 'text', text: 'done!' }] });
  const handle = await createTask(transport, 'tools/call', { name: 'slow', arguments: {} }, { ttlMs: 60_000 });
  assert.ok(handle instanceof TaskHandle);
  assert.equal(handle.taskId, 't1');
  assert.equal(handle.pollIntervalMs, 5);
  // _meta.task.ttl đã gửi kèm.
  const createCall = transport.called('tools/call')[0];
  assert.equal(createCall.params._meta.task.ttl, 60_000);

  const seen = [];
  const out = await handle.waitForCompletion({ onStatusChange: (s) => seen.push(s) });
  assert.equal(out.status, 'completed');
  assert.deepEqual(out.result, { content: [{ type: 'text', text: 'done!' }] });
  assert.equal(getGets(), 3);
  assert.deepEqual(seen, ['working', 'working', 'completed']);
});

test('tasks: waitForCompletion — failed / input_required ném TaskError rõ ràng', async () => {
  const failedTransport = new FakeTransport((method) => {
    if (method === 'tools/call') return { taskId: 't2', status: 'working', pollInterval: 5 };
    if (method === 'tasks/get') return { taskId: 't2', status: 'failed' };
    throw new Error(`unexpected ${method}`);
  });
  const failed = await createTask(failedTransport, 'tools/call', {});
  await assert.rejects(
    failed.waitForCompletion(),
    (e) => e instanceof TaskError && e.status === 'failed' && /thất bại/.test(e.message),
  );

  const inputTransport = new FakeTransport((method) => {
    if (method === 'tools/call') return { taskId: 't3', status: 'working', pollInterval: 5 };
    if (method === 'tasks/get') return { taskId: 't3', status: 'input_required' };
    throw new Error(`unexpected ${method}`);
  });
  const input = await createTask(inputTransport, 'tools/call', {});
  await assert.rejects(
    input.waitForCompletion(),
    (e) => e instanceof TaskError && e.status === 'input_required',
  );
});

test('tasks: cancel gọi tasks/cancel và đổi status thành cancelled', async () => {
  const { transport } = workingThenDoneTransport({});
  const handle = await createTask(transport, 'tools/call', {});
  await handle.cancel();
  assert.equal(handle.status, 'cancelled');
  assert.equal(transport.called('tasks/cancel').length, 1);
  assert.deepEqual(transport.called('tasks/cancel')[0].params, { taskId: 't1' });
});

test('tasks: waitForCompletion — AbortSignal huỷ vòng poll', async () => {
  const { transport } = workingThenDoneTransport({});
  const handle = await createTask(transport, 'tools/call', {});
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(handle.waitForCompletion({ signal: controller.signal }), {
    name: 'AbortError',
  });
});

test('tasks: waitForCompletion — hết timeoutMs ném TaskError', async () => {
  const transport = new FakeTransport((method) => {
    if (method === 'tools/call') return { taskId: 't4', status: 'working', pollInterval: 5 };
    if (method === 'tasks/get') return { taskId: 't4', status: 'working', pollInterval: 5 };
    throw new Error(`unexpected ${method}`);
  });
  const handle = await createTask(transport, 'tools/call', {});
  await assert.rejects(
    handle.waitForCompletion({ timeoutMs: 30 }),
    (e) => e instanceof TaskError && /hết thời gian chờ/.test(e.message),
  );
});

test('tasks: runTaskToCompletion + listTasks', async () => {
  const { transport } = workingThenDoneTransport({ ok: true });
  const result = await runTaskToCompletion(transport, 'tools/call', { name: 'slow' });
  assert.deepEqual(result, { ok: true });

  const listTransport = new FakeTransport((method) => {
    if (method === 'tasks/list') {
      return { tasks: [{ taskId: 'a', status: 'working' }, { taskId: 'b', status: 'completed' }] };
    }
    throw new Error(`unexpected ${method}`);
  });
  const listed = await listTasks(listTransport);
  assert.deepEqual(listed.map((t) => t.taskId), ['a', 'b']);
});

// --- Prompts -----------------------------------------------------------------

const PROMPTS_LIST = {
  prompts: [
    {
      name: 'summarize',
      description: 'Summarize text',
      arguments: [
        { name: 'text', description: 'Text to summarize', required: true },
        { name: 'style', description: 'Style' },
      ],
    },
    { name: 'hello', description: 'Say hello' },
  ],
};

test('prompts: listPrompts parse danh sách + argument', async () => {
  const transport = new FakeTransport((method) => {
    if (method === 'prompts/list') return PROMPTS_LIST;
    throw new Error(`unexpected ${method}`);
  });
  const prompts = await listPrompts(transport);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].name, 'summarize');
  assert.deepEqual(prompts[0].arguments, [
    { name: 'text', description: 'Text to summarize', required: true },
    { name: 'style', description: 'Style', required: undefined },
  ]);
  assert.equal(prompts[1].arguments, undefined);
});

test('prompts: getPrompt render message + kiểm tra argument bắt buộc', async () => {
  const transport = new FakeTransport((method, params) => {
    if (method === 'prompts/get') {
      assert.equal(params.name, 'summarize');
      return {
        description: 'Summarize text',
        messages: [
          { role: 'user', content: [{ type: 'text', text: `Summarize: ${params.arguments.text}` }] },
          { role: 'assistant', content: 'Sure.' },
        ],
      };
    }
    throw new Error(`unexpected ${method}`);
  });
  const promptDef = { name: 'summarize', arguments: [{ name: 'text', required: true }] };
  const rendered = await getPrompt(transport, 'summarize', { text: 'hello world' }, promptDef);
  assert.equal(rendered.description, 'Summarize text');
  assert.equal(rendered.messages.length, 2);
  assert.equal(rendered.messages[0].role, 'user');
  assert.equal(rendered.messages[0].text, 'Summarize: hello world');
  assert.equal(rendered.messages[1].text, 'Sure.');

  // Thiếu argument bắt buộc -> lỗi trước khi gọi transport.
  const callsBefore = transport.calls.length;
  await assert.rejects(
    getPrompt(transport, 'summarize', {}, promptDef),
    (e) => e instanceof PromptsError && /bắt buộc/.test(e.message),
  );
  assert.equal(transport.calls.length, callsBefore);
});

test('prompts: validatePromptArguments — thiếu bắt buộc + argument lạ', () => {
  const def = { name: 'p', arguments: [{ name: 'a', required: true }, { name: 'b' }] };
  assert.deepEqual(validatePromptArguments(def, { a: 'x' }), []);
  assert.deepEqual(validatePromptArguments(def, {}), ['Argument "a" là bắt buộc cho prompt "p"']);
  assert.deepEqual(validatePromptArguments(def, { a: 'x', z: 1 }), [
    'Argument "z" không có trong prompt "p"',
  ]);
});

// --- Resources subscribe / templates -----------------------------------------

test('prompts: subscribe/unsubscribe gọi đúng method với uri', async () => {
  const transport = new FakeTransport(() => ({}));
  await subscribeResource(transport, 'file:///notes.md');
  await unsubscribeResource(transport, 'file:///notes.md');
  assert.deepEqual(transport.called('resources/subscribe')[0].params, { uri: 'file:///notes.md' });
  assert.deepEqual(transport.called('resources/unsubscribe')[0].params, { uri: 'file:///notes.md' });
});

test('prompts: listResourceTemplates parse uriTemplate', async () => {
  const transport = new FakeTransport((method) => {
    if (method === 'resources/templates/list') {
      return {
        resourceTemplates: [
          { uriTemplate: 'file:///{path}', name: 'file', mimeType: 'text/plain' },
          { uriTemplate: 'db://{table}/{id}' },
        ],
      };
    }
    throw new Error(`unexpected ${method}`);
  });
  const templates = await listResourceTemplates(transport);
  assert.equal(templates.length, 2);
  assert.equal(templates[0].uriTemplate, 'file:///{path}');
  assert.equal(templates[0].mimeType, 'text/plain');
  assert.equal(templates[1].name, undefined);
});

test('prompts: ResourceWatcher — gom subscribe, dispatch đúng uri, unsubscribe khi hết listener', async () => {
  const transport = new FakeTransport(() => ({}));
  const watcher = new ResourceWatcher(transport);
  const gotA = [];
  const gotB = [];
  const listenerA = (n) => gotA.push(n.uri);
  const listenerA2 = (n) => gotA.push(`second:${n.uri}`);
  await watcher.subscribe('file:///a.md', listenerA);
  await watcher.subscribe('file:///a.md', listenerA2);
  await watcher.subscribe('file:///b.md', (n) => gotB.push(n.uri));
  // Gom: chỉ 1 lần subscribe cho a.md dù có 2 listener.
  assert.equal(transport.called('resources/subscribe').length, 2);
  assert.equal(watcher.subscribedCount, 2);

  transport.emit('notifications/resources/updated', { uri: 'file:///a.md' });
  transport.emit('notifications/resources/updated', { uri: 'file:///other.md' });
  assert.deepEqual(gotA, ['file:///a.md', 'second:file:///a.md']);
  assert.deepEqual(gotB, []);

  // Bỏ 1 trong 2 listener của a.md -> chưa unsubscribe server.
  await watcher.unsubscribe('file:///a.md', listenerA);
  assert.equal(transport.called('resources/unsubscribe').length, 0);
  // Bỏ listener cuối -> unsubscribe server.
  await watcher.unsubscribe('file:///a.md', listenerA2);
  assert.equal(transport.called('resources/unsubscribe').length, 1);
  assert.deepEqual(transport.called('resources/unsubscribe')[0].params, { uri: 'file:///a.md' });
  assert.equal(watcher.subscribedCount, 1);
  watcher.close();
});

test('prompts: onResourcesUpdated ném lỗi khi transport không nhận notification', () => {
  const plainTransport = { request: async () => ({}) };
  assert.throws(
    () => onResourcesUpdated(plainTransport, () => {}),
    (e) => e instanceof PromptsError && /không hỗ trợ nhận notification/.test(e.message),
  );
});

// --- Completion ----------------------------------------------------------------

test('prompts: completePromptArgument / completeResourceArgument gửi đúng ref', async () => {
  const transport = new FakeTransport((method, params) => {
    if (method === 'completion/complete') {
      return { completion: { values: ['Hanoi', 'Haiphong'], total: 2, hasMore: false } };
    }
    throw new Error(`unexpected ${method}`);
  });
  const promptResult = await completePromptArgument(transport, 'summarize', 'style', 'ha');
  assert.deepEqual(promptResult, { values: ['Hanoi', 'Haiphong'], total: 2, hasMore: false });
  const promptCall = transport.called('completion/complete')[0];
  assert.deepEqual(promptCall.params.ref, { type: 'ref/prompt', name: 'summarize' });
  assert.deepEqual(promptCall.params.argument, { name: 'style', value: 'ha' });

  const resourceResult = await completeResourceArgument(transport, 'file:///{path}', 'path', 'no');
  assert.deepEqual(resourceResult.values, ['Hanoi', 'Haiphong']);
  const resourceCall = transport.called('completion/complete')[1];
  assert.deepEqual(resourceCall.params.ref, { type: 'ref/resource', uri: 'file:///{path}' });
});

test('prompts: lỗi transport được bọc thành PromptsError', async () => {
  const failing = new FakeTransport(() => {
    throw new Error('boom');
  });
  await assert.rejects(listPrompts(failing), (e) => e instanceof PromptsError && /boom/.test(e.message));
  await assert.rejects(getPrompt(failing, 'x'), (e) => e instanceof PromptsError);
  await assert.rejects(listResourceTemplates(failing), (e) => e instanceof PromptsError);
});
