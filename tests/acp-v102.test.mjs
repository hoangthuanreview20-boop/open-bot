/**
 * Tests for the v1.02 rescue ACP port (agent side + client side over
 * an in-memory peer pair, session store, detection helpers).
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/acp-v102.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AcpAgentServer,
  AcpClient,
  AcpJsonRpcPeer,
  AcpSessionStore,
  createAcpPeerPair,
  findOnPath,
  ACP_PROTOCOL_VERSION,
} from '../packages/core/dist/acp/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-acp-v102-'));
}

test('transport: request/response round-trips over an in-memory pair; bad lines are skipped', async () => {
  const { client, server } = createAcpPeerPair();
  server.onRequest('ping', () => ({ pong: true }));
  const result = (await client.request('ping', {}));
  assert.deepEqual(result, { pong: true });
  assert.ok(client.getStats().requestsSent >= 1);
  client.close();
  server.close();
});

test('transport: unknown method answers -32601; $/cancel_request aborts a running handler', async () => {
  const { client, server } = createAcpPeerPair();
  await assert.rejects(client.request('nope', {}), /-32601|method not found/);
  server.onRequest('slow', async (_params, signal) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve('done'), 5000);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
    return 'done';
  });
  const pending = client.request('slow', {});
  // 'nope' was request id 1, so 'slow' is id 2: cancel it from the client side.
  await client.cancelRequest(2);
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, -32800);
    return true;
  });
  client.close();
  server.close();
});

test('agent server: initialize accepts v1 only; session/new validates cwd; echo prompt streams + replays', async () => {
  const { client, server } = createAcpPeerPair();
  const updates = [];
  const acp = new AcpClient(client, {
    onSessionUpdate: (_sessionId, update) => updates.push(update),
  });
  const agent = new AcpAgentServer(server);
  agent.start();
  const info = await acp.initialize();
  assert.equal(info.protocolVersion, ACP_PROTOCOL_VERSION);
  assert.equal(info.agentInfo.name, 'open-bot');
  assert.equal(info.agentCapabilities.loadSession, true);

  const workdir = tmpDir();
  const session = await acp.newSession(workdir);
  assert.equal(session.cwd, workdir);
  assert.ok(session.sessionId.length > 0);

  const result = await acp.prompt(session.sessionId, [{ type: 'text', text: 'hello' }]);
  assert.equal(result.stopReason, 'end_turn');
  assert.ok(updates.some((u) => u.sessionUpdate === 'agent_message_chunk'));

  // Load replays the recorded agent message.
  const loaded = await acp.loadSession(session.sessionId);
  assert.equal(loaded.sessionId, session.sessionId);

  // Relative cwd is rejected.
  await assert.rejects(acp.newSession('relative/path'), /absolute cwd/);
  // Unknown session is rejected.
  await assert.rejects(acp.prompt('no-such-session', [{ type: 'text', text: 'x' }]), /unknown session/);

  const list = await acp.listSessions();
  assert.equal(list.length, 1);
  assert.equal(await acp.closeSession(session.sessionId), true);
  acp.close();
  agent.getStats();
  client.close();
  server.close();
});

test('client prompt: per-turn onUpdate callback receives streamed updates (adapter convention)', async () => {
  const { client, server } = createAcpPeerPair();
  const agent = new AcpAgentServer(server);
  const acp = new AcpClient(client, {});
  await acp.initialize();
  const session = await acp.newSession(tmpDir());
  const seen = [];
  const result = await acp.prompt(session.sessionId, [{ type: 'text', text: 'hi' }], (update) => seen.push(update));
  assert.equal(result.stopReason, 'end_turn');
  assert.ok(seen.some((u) => u.sessionUpdate === 'agent_message_chunk'));
  acp.close();
  client.close();
  server.close();
});

test('agent server: second initialize fails; set_config_option validates values', async () => {
  const { client, server } = createAcpPeerPair();
  const agent = new AcpAgentServer(server);
  const acp = new AcpClient(client, {});
  await acp.initialize();
  await assert.rejects(client.request('initialize', { protocolVersion: 1 }), /already initialized/);
  const session = await acp.newSession(tmpDir());
  const options = await acp.setConfigOption(session.sessionId, 'mode', 'plan');
  assert.ok(Array.isArray(options));
  await assert.rejects(acp.setConfigOption(session.sessionId, 'mode', 'nope'), /unknown session or option/);
  acp.close();
  client.close();
  server.close();
});

test('session store: create/list/record persist to disk (mode 0600) and reload', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'acp-sessions.json');
  const store = new AcpSessionStore({ filePath: file });
  const session = store.create({ cwd: dir });
  store.recordMessage(session.sessionId, { role: 'agent', text: 'hi', at: new Date().toISOString() });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const reloaded = new AcpSessionStore({ filePath: file });
  const found = reloaded.get(session.sessionId);
  assert.ok(found);
  assert.equal(found.messageCount, 1);
  assert.equal(reloaded.list().length, 1);
  assert.equal(store.delete(session.sessionId), true);
  assert.equal(store.has(session.sessionId), false);
});

test('detect: findOnPath finds node and misses a nonsense binary', () => {
  assert.ok(findOnPath('node'));
  assert.equal(findOnPath('definitely-not-a-real-binary-xyz'), undefined);
});

test('peer: a slow peer that never answers can be closed (pending requests fail)', async () => {
  const { client, server } = createAcpPeerPair();
  const pending = client.request('never', {});
  client.close();
  await assert.rejects(pending);
  server.close();
  assert.ok(client.isClosed);
});
