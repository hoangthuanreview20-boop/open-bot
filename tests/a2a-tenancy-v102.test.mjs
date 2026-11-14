/**
 * Test v1.02 (Team T3): A2A multi-tenancy — tenant validation,
 * resolution order, context scoping, server-side task isolation
 * (direct + HTTP), and client tenant headers.
 *
 * Only loopback (no external network).
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/a2a-tenancy-v102.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidA2aTenantId,
  normalizeA2aTenantId,
  resolveA2aTenant,
  scopeA2aContextId,
  unscopeA2aContextId,
  taskBelongsToTenant,
  DEFAULT_A2A_TENANT,
  A2A_TENANT_HEADER,
} from '../packages/core/dist/a2a/tenancy.js';
import { createA2aServer, startA2aHttpServer } from '../packages/core/dist/a2a/server.js';
import { A2aClient } from '../packages/core/dist/a2a/client.js';

const TEST_TOKEN = 'test-token-v102-tenancy';
const serversToClose = [];
after(async () => {
  for (const s of serversToClose.splice(0)) await s.close().catch(() => undefined);
});

function echoRunner() {
  return async ({ text }) => ({ text: `echo: ${text}` });
}

function makeMessage(text) {
  return { kind: 'message', messageId: `m-${Math.random().toString(36).slice(2)}`, role: 'user', parts: [{ kind: 'text', text }] };
}

async function sendTask(server, text, ctx) {
  const res = await server.handleJsonRpc(
    { jsonrpc: '2.0', id: 1, method: 'message:send', params: { message: makeMessage(text) } },
    ctx,
  );
  assert.equal(res.error, undefined, JSON.stringify(res));
  return res.result;
}

test('tenant ids: validation, normalization, resolution order', () => {
  assert.equal(isValidA2aTenantId('team-a'), true);
  assert.equal(isValidA2aTenantId('team_a.1'), true);
  assert.equal(isValidA2aTenantId(''), false);
  assert.equal(isValidA2aTenantId('team a'), false);
  assert.equal(isValidA2aTenantId('team/a'), false);
  assert.equal(isValidA2aTenantId('x'.repeat(65)), false);
  assert.equal(isValidA2aTenantId(42), false);
  assert.equal(normalizeA2aTenantId(undefined), DEFAULT_A2A_TENANT);
  assert.equal(normalizeA2aTenantId(''), DEFAULT_A2A_TENANT);
  assert.equal(normalizeA2aTenantId('  team-a  '), 'team-a');
  assert.throws(() => normalizeA2aTenantId('bad id!'), /không hợp lệ/);
  // Header wins over _meta, _meta wins over explicit, default last.
  assert.equal(resolveA2aTenant({}).tenantId, 'default');
  assert.equal(resolveA2aTenant({ tenantId: 'team-a' }).tenantId, 'team-a');
  assert.equal(resolveA2aTenant({ tenantId: 'team-a', meta: { tenantId: 'team-b' } }).tenantId, 'team-b');
  assert.equal(
    resolveA2aTenant({ tenantId: 'team-a', meta: { tenantId: 'team-b' }, headers: { [A2A_TENANT_HEADER]: 'team-c' } }).tenantId,
    'team-c',
  );
  assert.throws(() => resolveA2aTenant({ tenantId: 'bad id!' }), /không hợp lệ/);
});

test('context ids: default tenant keeps the bare id, others are prefixed', () => {
  assert.equal(scopeA2aContextId('default', 'ctx-1'), 'ctx-1');
  assert.equal(scopeA2aContextId('team-a', 'ctx-1'), 'team-a:ctx-1');
  assert.deepEqual(unscopeA2aContextId('ctx-1'), { tenantId: 'default', contextId: 'ctx-1' });
  assert.deepEqual(unscopeA2aContextId('team-a:ctx-1'), { tenantId: 'team-a', contextId: 'ctx-1' });
  assert.equal(taskBelongsToTenant({ id: 't', contextId: 'c', status: { state: 'completed' } }, 'default'), true);
  assert.equal(
    taskBelongsToTenant({ id: 't', contextId: 'c', status: { state: 'completed' }, tenantId: 'team-a' }, 'team-a'),
    true,
  );
  assert.equal(
    taskBelongsToTenant({ id: 't', contextId: 'c', status: { state: 'completed' }, tenantId: 'team-a' }, 'team-b'),
    false,
  );
});

test('server isolation: tenants only see their own tasks (direct handleJsonRpc)', async () => {
  const server = createA2aServer({
    allowUnauthenticated: true,
    runner: echoRunner(),
    multiTenant: true,
  });
  const taskA = await sendTask(server, 'hello A', { tenantId: 'team-a' });
  assert.equal(taskA.tenantId, 'team-a');
  const taskB = await sendTask(server, 'hello B', { tenantId: 'team-b' });
  assert.equal(taskB.tenantId, 'team-b');
  // Default tenant (no tenant given) creates an unmarked task.
  const taskDefault = await sendTask(server, 'hello default', undefined);
  assert.equal(taskDefault.tenantId, undefined);

  // Cross-tenant reads look like "not found" (never a leak).
  assert.equal(server.getTask(taskA.id, 'team-b'), undefined);
  assert.equal(server.getTask(taskA.id, 'team-a')?.id, taskA.id);
  assert.equal(server.getTask(taskDefault.id, 'team-a'), undefined);
  assert.equal(server.getTask(taskDefault.id)?.id, taskDefault.id);

  // Lists are scoped per tenant.
  assert.deepEqual(server.listTasks('team-a').map((t) => t.id), [taskA.id]);
  assert.deepEqual(server.listTasks('team-b').map((t) => t.id), [taskB.id]);
  assert.deepEqual(server.listTasks().map((t) => t.id), [taskDefault.id]);

  // tasks/get + tasks/list over JSON-RPC honour the tenant too.
  const getCross = await server.handleJsonRpc(
    { jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { id: taskA.id } },
    { tenantId: 'team-b' },
  );
  assert.equal(getCross.error.code, -32602);
  const getOwn = await server.handleJsonRpc(
    { jsonrpc: '2.0', id: 3, method: 'tasks/get', params: { id: taskA.id } },
    { tenantId: 'team-a' },
  );
  assert.equal(getOwn.result.id, taskA.id);
  const listB = await server.handleJsonRpc(
    { jsonrpc: '2.0', id: 4, method: 'tasks/list', params: {} },
    { tenantId: 'team-b' },
  );
  assert.equal(listB.result.total, 1);
  assert.equal(listB.result.tasks[0].id, taskB.id);

  // _meta.tenantId works when no ctx is passed (direct mounts).
  const taskMeta = await server.handleJsonRpc({
    jsonrpc: '2.0',
    id: 5,
    method: 'message:send',
    params: { message: makeMessage('via meta'), _meta: { tenantId: 'team-c' } },
  });
  assert.equal(taskMeta.result.tenantId, 'team-c');
  assert.equal(server.getTask(taskMeta.result.id, 'team-a'), undefined);

  // Malformed tenant id is -32602, not a crash.
  const bad = await server.handleJsonRpc(
    { jsonrpc: '2.0', id: 6, method: 'tasks/list', params: {} },
    { tenantId: 'bad id!' },
  );
  assert.equal(bad.error.code, -32602);
});

test('single-tenant server: tenant header is ignored, old behaviour kept', async () => {
  const server = createA2aServer({ allowUnauthenticated: true, runner: echoRunner() });
  const task = await sendTask(server, 'hello', { tenantId: 'team-a' });
  assert.equal(task.tenantId, undefined);
  assert.equal(server.getTask(task.id, 'team-b')?.id, task.id);
  assert.equal(server.listTasks('team-b').length, 1);
});

test('HTTP: A2aClient tenant header isolates tasks end to end', async () => {
  const httpServer = await startA2aHttpServer(
    { allowUnauthenticated: true, runner: echoRunner(), multiTenant: true },
    { port: 0 },
  );
  serversToClose.push(httpServer);
  const clientA = new A2aClient({ baseUrl: httpServer.url, tenantId: 'team-a' });
  const clientB = new A2aClient({ baseUrl: httpServer.url, tenantId: 'team-b' });
  assert.equal(clientA.tenant, 'team-a');
  const taskA = await clientA.sendMessage('work for A');
  assert.equal(taskA.tenantId, 'team-a');
  // B cannot see A's task — the server answers "no task" over HTTP.
  await assert.rejects(clientB.getTask(taskA.id), /Không có task/);
  // A can.
  assert.equal((await clientA.getTask(taskA.id)).id, taskA.id);
  // Invalid tenant id fails fast in the client constructor.
  assert.throws(() => new A2aClient({ baseUrl: httpServer.url, tenantId: 'bad id!' }), /không hợp lệ/);
});
