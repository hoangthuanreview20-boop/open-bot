/**
 * coordinator-tracing.test.mjs — v0.10 wiring through the REAL coordinator
 * child process (NDJSON-RPC): createBot with `tracesFile`, run a turn with
 * a mock provider that calls a tool, then assert the JSONL trace file was
 * written with llm + tool spans for the right bot/run.
 *
 * No real API key, no network. Run:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/coordinator-tracing.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoordinatorClient } from '../packages/core/dist/coordinator/client.js';

const tmpDirs = [];
function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-coord-trace-'));
  tmpDirs.push(dir);
  return dir;
}

let client;
test.before(async () => {
  client = new CoordinatorClient();
  const pong = await client.ping();
  assert.equal(pong.pong, true, 'coordinator phải trả pong');
});

test.after(async () => {
  await client.dispose();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('coordinator run with tracesFile writes a JSONL trace (llm + tool spans)', async () => {
  const ws = tmpWorkspace();
  const tracesFile = path.join(ws, 'traces.jsonl');
  await client.createBot({
    bot: {
      id: 'bot-trace',
      name: 'Trace Bot',
      providerId: 'mock',
      model: 'mock',
      systemPrompt: 'You are a test bot.',
      workspaceDir: ws,
      autoApprove: true,
    },
    provider: {
      id: 'mock',
      label: 'Mock',
      mockResponses: [
        {
          text: '',
          toolCalls: [{ id: 'call-1', name: 'read_file', args: { path: 'a.txt' } }],
        },
        { text: 'đã đọc xong' },
      ],
    },
    tracesFile,
  });

  const result = await client.run('bot-trace', 'đọc file a.txt');
  assert.equal(result.text, 'đã đọc xong');
  assert.equal(typeof result.runId, 'string', 'runId must be echoed in RunResult');
  assert.ok(result.runId.length > 0);

  assert.ok(fs.existsSync(tracesFile), 'traces file must exist after the run');
  const lines = fs
    .readFileSync(tracesFile, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  assert.equal(lines.length, 1, 'exactly one trace for one run');
  const trace = JSON.parse(lines[0]);
  assert.equal(trace.botId, 'bot-trace');
  assert.equal(trace.runId, result.runId);
  const kinds = trace.spans.map((s) => s.kind);
  assert.ok(kinds.includes('llm'), `trace must have an llm span, got ${kinds.join(',')}`);
  assert.ok(kinds.includes('tool'), `trace must have a tool span, got ${kinds.join(',')}`);
  const toolSpan = trace.spans.find((s) => s.kind === 'tool');
  assert.equal(toolSpan.name, 'read_file');
});

test('coordinator run without tracesFile still works (tracing is optional)', async () => {
  const ws = tmpWorkspace();
  await client.createBot({
    bot: {
      id: 'bot-notrace',
      name: 'No Trace Bot',
      providerId: 'mock',
      model: 'mock',
      systemPrompt: 'You are a test bot.',
      workspaceDir: ws,
      autoApprove: true,
    },
    provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'ok' }] },
  });
  const result = await client.run('bot-notrace', 'chào');
  assert.equal(result.text, 'ok');
  assert.equal(fs.existsSync(path.join(ws, 'traces.jsonl')), false);
});
