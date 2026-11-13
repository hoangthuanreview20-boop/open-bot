/**
 * Test v0.97 T1: MCP 2.0 stateless transport (node:test).
 * Local only, no live network: a fake client records requests.
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-v097-stateless.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildServerDiscoverResult,
  buildStatelessMeta,
  discoverServer,
  isKnownProtocolVersion,
  negotiateStatelessVersion,
  parseServerDiscoverResult,
  parseStatelessMeta,
  requestStateless,
  withStatelessMeta,
  MCP_PROTOCOL_VERSION_2026,
  MCP_PROTOCOL_VERSIONS_2026,
  MCP_SERVER_DISCOVER_METHOD,
  StatelessMcpError,
} from '../packages/core/dist/mcp/stateless.js';

function fakeClient(handler) {
  return {
    calls: [],
    async requestJsonRpc(method, params) {
      this.calls.push({ method, params });
      return handler(method, params);
    },
  };
}

test('stateless: version constants — 2026-07-28 is newest, known versions list', () => {
  assert.equal(MCP_PROTOCOL_VERSION_2026, '2026-07-28');
  assert.equal(MCP_PROTOCOL_VERSIONS_2026[0], '2026-07-28');
  assert.ok(MCP_PROTOCOL_VERSIONS_2026.includes('2025-11-25'));
  assert.ok(MCP_PROTOCOL_VERSIONS_2026.includes('2024-11-05'));
  assert.equal(isKnownProtocolVersion('2026-07-28'), true);
  assert.equal(isKnownProtocolVersion('2025-11-25'), true);
  assert.equal(isKnownProtocolVersion('1999-01-01'), false);
  assert.equal(isKnownProtocolVersion(undefined), false);
});

test('stateless: negotiateStatelessVersion picks the newest shared version', () => {
  assert.equal(negotiateStatelessVersion('2026-07-28', ['2026-07-28', '2025-11-25']), '2026-07-28');
  assert.equal(negotiateStatelessVersion('2025-11-25', ['2025-11-25']), '2025-11-25');
  assert.equal(negotiateStatelessVersion(undefined, undefined), '2026-07-28');
  assert.equal(negotiateStatelessVersion(undefined, ['2025-11-25']), '2025-11-25');
  // No overlap: falls back to the client default instead of throwing.
  assert.equal(negotiateStatelessVersion('2030-01-01', ['2030-01-01']), '2026-07-28');
});

test('stateless: buildStatelessMeta defaults to 2026-07-28 with MRTR/tasks/apps capabilities', () => {
  const meta = buildStatelessMeta();
  assert.equal(meta.protocolVersion, '2026-07-28');
  assert.equal(meta.clientCapabilities?.multiRoundTrip, true);
  assert.equal(meta.clientCapabilities?.tasks, true);
  assert.equal(meta.clientCapabilities?.apps, true);
  const custom = buildStatelessMeta({
    protocolVersion: '2025-11-25',
    capabilities: { tasks: true },
    clientInfo: { name: 'test-client', version: '1.0.0' },
    roundTrip: { roundTripId: 'rt-1', round: 2 },
    task: { taskId: 'task-1' },
  });
  assert.equal(custom.protocolVersion, '2025-11-25');
  assert.equal(custom.clientCapabilities?.multiRoundTrip, undefined);
  assert.equal(custom.clientInfo?.name, 'test-client');
  assert.equal(custom.roundTrip?.round, 2);
  assert.equal(custom.task?.taskId, 'task-1');
});

test('stateless: parseStatelessMeta round-trips a built meta, rejects garbage', () => {
  const meta = buildStatelessMeta({ clientInfo: { name: 'c', version: '0.1' } });
  const parsed = parseStatelessMeta({ ...meta });
  assert.equal(parsed?.protocolVersion, '2026-07-28');
  assert.equal(parsed?.clientCapabilities?.tasks, true);
  assert.equal(parsed?.clientInfo?.name, 'c');
  assert.equal(parseStatelessMeta(undefined), null);
  assert.equal(parseStatelessMeta('nope'), null);
  assert.equal(parseStatelessMeta({}), null);
  assert.equal(parseStatelessMeta({ protocolVersion: '' }), null);
  // Unknown extra fields are ignored (forward compatibility).
  const extra = parseStatelessMeta({ protocolVersion: '2026-07-28', futureField: 42 });
  assert.equal(extra?.protocolVersion, '2026-07-28');
  // Malformed roundTrip / task are dropped, the rest still parses.
  const partial = parseStatelessMeta({
    protocolVersion: '2026-07-28',
    roundTrip: { roundTripId: 7 },
    task: { taskId: 't-1' },
  });
  assert.equal(partial?.roundTrip, undefined);
  assert.equal(partial?.task?.taskId, 't-1');
});

test('stateless: withStatelessMeta copies params and preserves existing _meta fields', () => {
  const params = { name: 'x', _meta: { progressToken: 'tok-1' } };
  const out = withStatelessMeta(params, buildStatelessMeta());
  assert.equal(out['name'], 'x');
  assert.equal(out['_meta']['progressToken'], 'tok-1');
  assert.equal(out['_meta']['protocolVersion'], '2026-07-28');
  // The caller's object is not mutated (it may be reused for retries).
  assert.equal(params['_meta']['protocolVersion'], undefined);
  assert.deepEqual(withStatelessMeta(undefined, buildStatelessMeta())['_meta']['protocolVersion'], '2026-07-28');
});

test('stateless: discoverServer parses a discovery document', async () => {
  const client = fakeClient(() => ({
    protocolVersion: '2026-07-28',
    supportedVersions: ['2026-07-28', '2025-11-25'],
    capabilities: { tools: {}, tasks: { extension: 'io.modelcontextprotocol/tasks' } },
    serverInfo: { name: 'fake-server', version: '1.2.3' },
    extensions: ['io.modelcontextprotocol/tasks'],
  }));
  const result = await discoverServer(client);
  assert.equal(result?.protocolVersion, '2026-07-28');
  assert.equal(result?.serverInfo.name, 'fake-server');
  assert.deepEqual(result?.supportedVersions, ['2026-07-28', '2025-11-25']);
  assert.deepEqual(result?.extensions, ['io.modelcontextprotocol/tasks']);
  // The request carried its own _meta — no handshake, no session id.
  assert.equal(client.calls[0].method, MCP_SERVER_DISCOVER_METHOD);
  assert.equal(client.calls[0].params['_meta'].protocolVersion, '2026-07-28');
});

test('stateless: discoverServer returns null on -32601 (pre-2.0 server), throws on transport errors', async () => {
  const oldClient = fakeClient(() => {
    throw new Error('MCP server "x" error -32601: Method not found');
  });
  assert.equal(await discoverServer(oldClient), null);
  const downClient = fakeClient(() => {
    throw new Error('connect ECONNREFUSED');
  });
  await assert.rejects(() => discoverServer(downClient), /ECONNREFUSED/);
});

test('stateless: parseServerDiscoverResult rejects unusable documents', () => {
  assert.throws(() => parseServerDiscoverResult(null), StatelessMcpError);
  assert.throws(() => parseServerDiscoverResult({}), StatelessMcpError);
  assert.throws(
    () => parseServerDiscoverResult({ protocolVersion: '2026-07-28', serverInfo: { name: 'x' } }),
    StatelessMcpError,
  );
  const ok = parseServerDiscoverResult({
    protocolVersion: '2026-07-28',
    capabilities: {},
    serverInfo: { name: 's', version: '0.1' },
  });
  assert.equal(ok.capabilities.tools, undefined);
  assert.equal(ok.supportedVersions, undefined);
});

test('stateless: requestStateless attaches _meta and sends no session', async () => {
  const client = fakeClient(() => ({ tools: [] }));
  const result = await requestStateless(client, 'tools/list', {});
  assert.deepEqual(result, { tools: [] });
  const params = client.calls[0].params;
  assert.equal(params['_meta'].protocolVersion, '2026-07-28');
  assert.equal(params['_meta'].clientCapabilities.apps, true);
});

test('stateless: buildServerDiscoverResult lists exactly what the server offers', () => {
  const full = buildServerDiscoverResult({
    name: 'open-bot',
    version: '0.2.0',
    hasTools: true,
    hasResources: true,
    hasPrompts: false,
    tasksSupported: true,
    appsSupported: true,
  });
  assert.equal(full.protocolVersion, '2026-07-28');
  assert.ok('tools' in full.capabilities);
  assert.ok('resources' in full.capabilities);
  assert.ok(!('prompts' in full.capabilities));
  assert.ok(full.extensions?.includes('io.modelcontextprotocol/tasks'));
  assert.ok(full.extensions?.includes('io.modelcontextprotocol/apps'));
  const minimal = buildServerDiscoverResult({
    name: 'tiny',
    version: '0.1',
    hasTools: false,
    hasResources: false,
    hasPrompts: false,
    tasksSupported: false,
    appsSupported: false,
  });
  assert.deepEqual(minimal.capabilities, {});
  assert.deepEqual(minimal.extensions, []);
});
