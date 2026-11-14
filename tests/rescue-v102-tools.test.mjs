/**
 * Tests for the v1.02 rescue tools (context/durable/orchestra/
 * gateway/dream/substrate/ACP) wired into ALL_TOOLS.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/rescue-v102-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ALL_TOOLS, createRescueV102Tools } from '../packages/tools/dist/index.js';
import { BotMemory, defaultToolFactory } from '../packages/core/dist/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-rescue-tools-v102-'));
}

function ctx(workspaceDir) {
  return {
    workspaceDir,
    botId: 'bot-1',
    runSubagent: async (task) => `subagent result for: ${task.slice(0, 40)}`,
  };
}

function tool(name) {
  const found = createRescueV102Tools().find((t) => t.definition.name === name);
  assert.ok(found, `tool ${name} exists`);
  return found;
}

test('registry: all 12 rescue tools are in ALL_TOOLS exactly once; the full registry counts 259', () => {
  const expected = [
    'context_measure_budget',
    'context_prune_history',
    'durable_list_resumable',
    'durable_resume_state',
    'orchestra_run',
    'orchestra_list_sessions',
    'gateway_status',
    'gateway_send',
    'dream_run',
    'substrate_snapshot',
    'substrate_list_snapshots',
    'acp_detect_agents',
  ];
  for (const name of expected) {
    assert.equal(ALL_TOOLS.filter((t) => t.definition.name === name).length, 1, name);
  }
  // The full agent registry (defaultToolFactory) counts every tool
  // the agent can call: 238 in v1.01 + 9 memory v3 (Đội T2) + these 12 = 259.
  const ws = tmpDir();
  const mem = new BotMemory(ws);
  try {
    const tools = defaultToolFactory(mem, ws, 'bot-1');
    const names = tools.map((t) => t.definition.name);
    assert.equal(names.length, 259, `expected 259 tools, got ${names.length}`);
    assert.equal(new Set(names).size, names.length, 'duplicate tool names');
    for (const name of expected) assert.ok(names.includes(name), name);
  } finally {
    mem.close();
  }
  // Mutating tools need approval; read-only ones do not.
  assert.equal(tool('orchestra_run').needsApproval, true);
  assert.equal(tool('gateway_send').needsApproval, true);
  assert.equal(tool('dream_run').needsApproval, true);
  assert.equal(tool('substrate_snapshot').needsApproval, true);
  assert.equal(tool('context_measure_budget').needsApproval, false);
  assert.equal(tool('acp_detect_agents').needsApproval, false);
});

test('context tools: measure budget + prune history end to end', async () => {
  const dir = tmpDir();
  const measured = JSON.parse(await tool('context_measure_budget').execute({
    model: 'gpt-3.5-turbo',
    systemPrompt: 'Be helpful.',
    messages: JSON.stringify([{ role: 'user', content: 'Hello world' }]),
  }, ctx(dir)));
  assert.equal(measured.fits, true);
  assert.ok(measured.usedTokens > 0);

  const pruned = JSON.parse(await tool('context_prune_history').execute({
    messages: JSON.stringify([
      { role: 'user', content: 'Explain quantum computing in detail please.' },
      { role: 'assistant', content: 'Quantum computing uses qubits.' },
      { role: 'user', content: 'Tell me about quantum entanglement.' },
    ]),
    tokensToFree: 5,
    latestUserText: 'quantum entanglement',
  }, ctx(dir)));
  assert.ok(pruned.kept.length >= 1);
  assert.equal(typeof pruned.summary, 'string');
});

test('durable tools: list resumable (empty) + resume missing run', async () => {
  const dir = tmpDir();
  const listed = JSON.parse(await tool('durable_list_resumable').execute({}, ctx(dir)));
  assert.deepEqual(listed, []);
  const missing = await tool('durable_resume_state').execute({ runId: 'no-such-run' }, ctx(dir));
  assert.match(missing, /No journal found/);
});

test('orchestra tools: list (empty) + run a goal through the mock subagent', async () => {
  const dir = tmpDir();
  const listed = JSON.parse(await tool('orchestra_list_sessions').execute({}, ctx(dir)));
  assert.deepEqual(listed, []);
  const result = JSON.parse(await tool('orchestra_run').execute({
    goal: 'Write docs',
    subtasks: JSON.stringify(['Outline', 'Draft']),
  }, ctx(dir)));
  assert.equal(result.status, 'done');
  assert.match(result.merged.combinedOutput, /subagent result/);
  const listedAfter = JSON.parse(await tool('orchestra_list_sessions').execute({}, ctx(dir)));
  assert.equal(listedAfter.length, 1);
});

test('gateway tools: status shows disabled channels; send goes through the mock transport', async () => {
  const dir = tmpDir();
  const status = JSON.parse(await tool('gateway_status').execute({}, ctx(dir)));
  assert.equal(Object.keys(status).length, 4);
  assert.ok(Object.values(status).every((s) => s === 'disabled' || s === 'mock'));
  // The default transport is the mock: the send "succeeds" as a dry run.
  const sent = await tool('gateway_send').execute({
    channel: 'telegram', chatId: '1', text: 'hi',
  }, ctx(dir));
  assert.match(sent, /Sent via telegram \(message id mock-/);
  await assert.rejects(tool('gateway_send').execute({
    channel: 'carrier-pigeon', chatId: '1', text: 'hi',
  }, ctx(dir)), /unknown gateway channel/);
});

test('dream + substrate tools: snapshot round-trip through the tools', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
  const snapshot = JSON.parse(await tool('substrate_snapshot').execute({ botId: 'bot-1', note: 'first' }, ctx(dir)));
  assert.ok(snapshot.snapshotId.length > 0);
  assert.equal(snapshot.files, 1);
  const listed = JSON.parse(await tool('substrate_list_snapshots').execute({ botId: 'bot-1' }, ctx(dir)));
  assert.equal(listed.length, 1);
  assert.equal(listed[0].note, 'first');
  const dream = JSON.parse(await tool('dream_run').execute({}, ctx(dir)));
  assert.equal(dream.notesSeen, 0);
});

test('acp detect: runs without network and returns a list', async () => {
  const dir = tmpDir();
  const result = JSON.parse(await tool('acp_detect_agents').execute({}, ctx(dir)));
  assert.ok(Array.isArray(result));
});
