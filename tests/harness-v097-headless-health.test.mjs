/**
 * Tests for harness v2 — headless jobs, NDJSON event export, health
 * probe, and the read-only harness tools (v0.97, Team T5).
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/harness-v097-headless-health.test.mjs
 *
 * No provider, no network, no real machine dependence: the job
 * runner uses a fake bot runner, the health probe uses injected
 * measurements, and the tools read temp dirs only.
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';

import {
  APPROVAL_DENIED_TEXT,
  BotComputerHealthProber,
  HARNESS_V2_EVENT_VERSION,
  HeadlessJobRunner,
  NdjsonEventExporter,
  classifyBotComputerHealth,
  followNdjsonFile,
  loadHeadlessJobFile,
  parseDfUsedRatio,
  parseHeadlessJobFile,
  parseNdjsonEventLine,
  probeBotComputerHealth,
  readNdjsonEventFile,
  readNdjsonEvents,
  shouldBypassRouter,
  tailNdjsonEvents,
} from '../packages/core/dist/index.js';
import { createHarnessV2Tools } from '../packages/tools/dist/index.js';

const tmpDirs = [];
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

class CaptureStream extends Writable {
  constructor() {
    super();
    this.text = '';
  }
  _write(chunk, _encoding, callback) {
    this.text += chunk.toString('utf8');
    callback();
  }
}

// --- headless job files ---------------------------------------------------

test('v0.97 headless: parseHeadlessJobFile validates version / bot / prompt / limits', () => {
  const ok = parseHeadlessJobFile({ version: 1, provider: 'mock', model: 'mock', prompt: 'hi' });
  assert.equal(ok.version, 1);
  assert.equal(ok.provider, 'mock');
  assert.throws(() => parseHeadlessJobFile({ version: 2, prompt: 'hi' }), /Unsupported job file version/);
  assert.throws(() => parseHeadlessJobFile({ version: 1, prompt: 'hi' }), /needs "bot"/);
  assert.throws(() => parseHeadlessJobFile({ version: 1, provider: 'x', prompt: 'hi' }), /also needs "model"/);
  assert.throws(() => parseHeadlessJobFile({ version: 1, bot: 'b' }), /non-empty "prompt"/);
  assert.throws(() => parseHeadlessJobFile({ version: 1, bot: 'b', prompt: '   ' }), /non-empty "prompt"/);
  assert.throws(
    () => parseHeadlessJobFile({ version: 1, bot: 'b', prompt: 'x', imageFiles: ['1', '2', '3', '4', '5', '6'] }),
    /at most 5 images/,
  );
  assert.throws(() => parseHeadlessJobFile({ version: 1, bot: 'b', prompt: 'x', timeoutMs: 0 }), /positive integer/);
  assert.throws(() => parseHeadlessJobFile({ version: 1, bot: 'b', prompt: 'x', autoApprove: 'yes' }), /boolean/);
  const full = parseHeadlessJobFile({
    version: 1, name: 'nightly', bot: 'bot-1', prompt: 'go', timeoutMs: 60000,
    autoApprove: false, ndjson: true, ndjsonFile: 'out.ndjson', routineId: 'r-1',
  });
  assert.equal(full.name, 'nightly');
  assert.equal(full.timeoutMs, 60000);
});

test('v0.97 headless: loadHeadlessJobFile reads disk, rejects bad JSON and bad jobs', () => {
  const dir = tmpDir('open-bot-h2-job-');
  const good = path.join(dir, 'job.json');
  fs.writeFileSync(good, JSON.stringify({ version: 1, provider: 'mock', model: 'mock', prompt: 'hi' }));
  assert.equal(loadHeadlessJobFile(good).prompt, 'hi');
  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{nope');
  assert.throws(() => loadHeadlessJobFile(broken), /not valid JSON/);
  const invalid = path.join(dir, 'invalid.json');
  fs.writeFileSync(invalid, JSON.stringify({ version: 1 }));
  assert.throws(() => loadHeadlessJobFile(invalid), /needs "bot"/);
  assert.throws(() => loadHeadlessJobFile(path.join(dir, 'missing.json')), /Cannot read job file/);
});

test('v0.97 headless: shouldBypassRouter exempts mock and CLI-kind providers only', () => {
  assert.equal(shouldBypassRouter('mock'), true);
  assert.equal(shouldBypassRouter('MOCK'), true);
  assert.equal(shouldBypassRouter('claude-code'), true);
  assert.equal(shouldBypassRouter('codex'), true);
  assert.equal(shouldBypassRouter('gemini-cli'), true);
  assert.equal(shouldBypassRouter('openai'), false);
  assert.equal(shouldBypassRouter('gemini'), false);
  assert.equal(shouldBypassRouter('ollama'), false);
  assert.equal(shouldBypassRouter(''), false);
});

test('v0.97 headless: runner returns ok result (exit 0) and emits v2 NDJSON events', async () => {
  const stream = new CaptureStream();
  const runner = new HeadlessJobRunner(
    async (job, opts) => {
      assert.equal(opts.bypassRouter, true);
      assert.equal(job.provider, 'mock');
      return { botId: 'bot-mock', botName: 'Mock', text: 'mock reply', stopped: false, runId: 'run-1' };
    },
    { ndjsonStream: stream },
  );
  const result = await runner.runJob({ version: 1, provider: 'mock', model: 'mock', prompt: 'hi', ndjson: true });
  assert.equal(result.exitCode, 0);
  assert.equal(result.approvalDenied, false);
  assert.equal(result.text, 'mock reply');
  assert.equal(result.eventsEmitted, 2);
  assert.ok(result.durationMs >= 0);
  const { events, skipped } = readNdjsonEvents(stream.text);
  assert.equal(skipped, 0);
  assert.equal(events.length, 2);
  assert.equal(events[0].v, HARNESS_V2_EVENT_VERSION);
  assert.equal(events[0].kind, 'cli.job.started');
  assert.equal(events[0].seq, 0);
  assert.equal(events[1].kind, 'cli.job.completed');
  assert.equal(events[1].seq, 1);
  assert.equal(events[1].payload.exitCode, 0);
  assert.equal(events[1].payload.bypassRouter, undefined); // completed payload carries no router flag
});

test('v0.97 headless: approval-denied text maps to exit 3; a throwing runner maps to exit 2', async () => {
  const denied = new HeadlessJobRunner(async () => ({
    botId: 'b', botName: 'B', text: APPROVAL_DENIED_TEXT, stopped: true, runId: 'r-denied',
  }));
  const deniedResult = await denied.runJob({ version: 1, provider: 'mock', model: 'mock', prompt: 'hi' });
  assert.equal(deniedResult.exitCode, 3);
  assert.equal(deniedResult.approvalDenied, true);

  const failing = new HeadlessJobRunner(async () => {
    throw new Error('provider exploded');
  });
  const failedResult = await failing.runJob({ version: 1, provider: 'mock', model: 'mock', prompt: 'hi' });
  assert.equal(failedResult.exitCode, 2);
  assert.match(failedResult.text, /provider exploded/);
});

test('v0.97 headless: a hung runner is cut off by the job timeout (exit 2)', async () => {
  const slow = new HeadlessJobRunner(async (_job, opts) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(undefined), 60_000);
      timer.unref?.();
      opts.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('aborted by timeout'));
      });
    });
    return { botId: 'b', botName: 'B', text: 'too late', stopped: false, runId: 'r-late' };
  });
  const result = await slow.runJob({ version: 1, provider: 'mock', model: 'mock', prompt: 'hi', timeoutMs: 50 });
  assert.equal(result.exitCode, 2);
  assert.match(result.text, /timed out/);
});

test('v0.97 headless: ndjsonFile moves the thread file to the exact requested path', async () => {
  const dir = tmpDir('open-bot-h2-ndjson-');
  const target = path.join(dir, 'events.ndjson');
  const runner = new HeadlessJobRunner(
    async () => ({ botId: 'b', botName: 'B', text: 'ok', stopped: false, runId: 'r-1' }),
    { ndjsonDir: dir },
  );
  const result = await runner.runJob({
    version: 1, name: 'file-job', provider: 'mock', model: 'mock', prompt: 'hi',
    ndjson: true, ndjsonFile: target,
  });
  assert.equal(result.exitCode, 0);
  assert.ok(fs.existsSync(target));
  const { events } = readNdjsonEventFile(target);
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, 'cli.job.started');
});

// --- NDJSON event export --------------------------------------------------

test('v0.97 ndjson: parse validates the v2 envelope and skips corrupt / foreign lines', () => {
  const good = JSON.stringify({ v: 2, seq: 0, at: '2026-11-13T00:00:00.000Z', kind: 'routine.started', botId: 'b', threadId: 't', payload: {} });
  assert.equal(parseNdjsonEventLine(good)?.kind, 'routine.started');
  assert.equal(parseNdjsonEventLine(''), null);
  assert.equal(parseNdjsonEventLine('{broken'), null);
  assert.equal(parseNdjsonEventLine(JSON.stringify({ v: 1, seq: 0, at: 'x', kind: 'text', botId: 'b', threadId: 't', payload: {} })), null);
  assert.equal(parseNdjsonEventLine(JSON.stringify({ v: 2, seq: 0, at: 'x', kind: 'not-a-kind', botId: 'b', threadId: 't', payload: {} })), null);
  const { events, skipped } = readNdjsonEvents(`${good}\n{broken}\n\n${good}\n`);
  assert.equal(events.length, 2);
  assert.equal(skipped, 1);
});

test('v0.97 ndjson: exporter writes per-thread files, sanitizes secrets, rotates, reads back', () => {
  const dir = tmpDir('open-bot-h2-export-');
  const exporter = new NdjsonEventExporter(dir, { maxFileBytes: 200, maxTotalBytes: 10 * 1024 * 1024 });
  const event = exporter.emit('routine.started', 'bot-1', 'thread-1', { runId: 'r1', token: 'sk-secret-value' });
  assert.equal(event.v, 2);
  assert.equal(event.seq, 0);
  exporter.emit('health.probe', 'bot-1', 'thread-1', { status: 'healthy' });
  const page = exporter.readThread('thread-1');
  assert.equal(page.total, 2);
  assert.equal(page.events[0].payload.token, '<redacted>');
  assert.deepEqual(exporter.listThreads(), ['thread-1']);
  assert.equal(exporter.stats.emitted, 2);
  // Rotation: many events force a rotated file, but nothing is lost.
  for (let i = 0; i < 20; i++) {
    exporter.emit('text', 'bot-1', 'thread-1', { delta: `event number ${i} with some padding text to grow the file` });
  }
  assert.ok(exporter.stats.rotated >= 1);
  assert.equal(exporter.readThread('thread-1').total, 22);
  // tail reads the live file only (older events live in rotated
  // files, still readable via readThread above): newest last.
  const file = path.join(dir, 'thread-1.ndjson');
  const tailed = tailNdjsonEvents(file, 3);
  assert.ok(tailed.length >= 1 && tailed.length <= 3);
  assert.equal(tailed[tailed.length - 1].payload.delta, 'event number 19 with some padding text to grow the file');
});

test('v0.97 ndjson: exporter also streams to a Writable and never throws on a dead dir', () => {
  const stream = new CaptureStream();
  const exporter = new NdjsonEventExporter(undefined, { stream });
  exporter.emit('cli.job.started', 'mock', 'headless-x', { jobName: 'x' });
  assert.equal(exporter.stats.emitted, 1);
  const { events } = readNdjsonEvents(stream.text);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'cli.job.started');
  // A directory that cannot be created (a file in the way) only counts errors.
  const dir = tmpDir('open-bot-h2-export-');
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const broken = new NdjsonEventExporter(path.join(blocker, 'sub'));
  broken.emit('text', 'b', 't', { delta: 'hi' });
  assert.equal(broken.stats.writeErrors, 1);
});

test('v0.97 ndjson: followNdjsonFile calls back for appended events only', async () => {
  const dir = tmpDir('open-bot-h2-follow-');
  const file = path.join(dir, 'thread.ndjson');
  fs.writeFileSync(file, '');
  const seen = [];
  const handle = followNdjsonFile(file, (event) => seen.push(event), { pollMs: 20 });
  try {
    const exporter = new NdjsonEventExporter(dir);
    exporter.emit('text', 'b', 'thread', { delta: 'one' });
    exporter.emit('text', 'b', 'thread', { delta: 'two' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(seen.length, 2);
    assert.equal(seen[0].payload.delta, 'one');
    assert.equal(seen[1].payload.delta, 'two');
    assert.equal(handle.errors, 0);
  } finally {
    handle.stop();
    handle.stop();
  }
});

// --- health probe ---------------------------------------------------------

test('v0.97 health: classifyBotComputerHealth — healthy / degraded / unhealthy / unknown', () => {
  assert.deepEqual(classifyBotComputerHealth({ cpuLoad: 0.2, memoryUsedRatio: 0.5, diskUsedRatio: 0.3, processAlive: true, probeDurationMs: 10 }), { status: 'healthy', reasons: [] });
  const degraded = classifyBotComputerHealth({ cpuLoad: 0.9, memoryUsedRatio: 0.5, probeDurationMs: 10 });
  assert.equal(degraded.status, 'degraded');
  assert.match(degraded.reasons.join(' '), /CPU load/);
  const unhealthy = classifyBotComputerHealth({ cpuLoad: 0.99, memoryUsedRatio: 0.99, diskUsedRatio: 0.99, processAlive: false, heartbeatAgeMs: 400_000, probeDurationMs: 10 });
  assert.equal(unhealthy.status, 'unhealthy');
  assert.ok(unhealthy.reasons.length >= 4);
  const stale = classifyBotComputerHealth({ heartbeatAgeMs: 120_000, probeDurationMs: 10 });
  assert.equal(stale.status, 'degraded');
  const slow = classifyBotComputerHealth({ cpuLoad: 0.1, probeDurationMs: 9000 });
  assert.equal(slow.status, 'degraded');
  assert.deepEqual(classifyBotComputerHealth({ probeDurationMs: 10 }), { status: 'unknown', reasons: ['Nothing measurable for this computer yet.'] });
});

test('v0.97 health: parseDfUsedRatio reads df output, rejects garbage', () => {
  assert.equal(parseDfUsedRatio('Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 100 12 88 12% /\n'), 0.12);
  assert.equal(parseDfUsedRatio('Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 100 99 1 99% /\n'), 0.99);
  assert.equal(parseDfUsedRatio(''), null);
  assert.equal(parseDfUsedRatio('only one line'), null);
  assert.equal(parseDfUsedRatio('Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 100 12 88 nope /\n'), null);
});

test('v0.97 health: probeBotComputerHealth with injected deps — healthy and unhealthy', async () => {
  const now = new Date('2026-11-13T12:00:00.000Z');
  const healthy = await probeBotComputerHealth(
    { botId: 'bot-1', pid: 1234, lastHeartbeatAt: '2026-11-13T11:59:50.000Z' },
    {
      loadavg: [0.4, 0.4, 0.4], cpuCount: 4, totalmem: 8 * 1024 ** 3, freemem: 4 * 1024 ** 3,
      diskUsedRatio: 0.4, pidAlive: () => true, now: () => now,
    },
  );
  assert.equal(healthy.status, 'healthy');
  assert.equal(healthy.cpuLoad, 0.1);
  assert.equal(healthy.memoryUsedRatio, 0.5);
  assert.equal(healthy.processAlive, true);
  assert.equal(healthy.heartbeatAgeMs, 10_000);

  const sick = await probeBotComputerHealth(
    { botId: 'bot-2', pid: 9999, lastHeartbeatAt: '2026-11-13T11:00:00.000Z' },
    {
      loadavg: [3.9, 3.9, 3.9], cpuCount: 4, totalmem: 8 * 1024 ** 3, freemem: 100 * 1024 ** 2,
      diskUsedRatio: 0.98, pidAlive: () => false, now: () => now,
    },
  );
  assert.equal(sick.status, 'unhealthy');
  assert.equal(sick.processAlive, false);
  assert.ok(sick.reasons.some((r) => r.includes('no longer alive')));
});

test('v0.97 health: prober keeps history and only reports on status change or unhealthy', async () => {
  const reported = [];
  const prober = new BotComputerHealthProber({
    deps: { loadavg: [0.2], cpuCount: 4, totalmem: 100, freemem: 50, diskUsedRatio: 0.2, pidAlive: () => true },
    onHealth: (health) => reported.push(health),
  });
  prober.register({ botId: 'bot-1' });
  prober.register({ botId: 'bot-2', pid: 4242 });
  const first = await prober.probeAll();
  assert.equal(first.length, 2);
  assert.equal(first[0].status, 'healthy');
  assert.equal(prober.latest('bot-1')?.status, 'healthy');
  assert.equal(prober.unhealthyCount(), 0);
  assert.equal(reported.length, 2); // first probe of each bot is a status change (undefined -> healthy)
  await prober.probeAll();
  assert.equal(reported.length, 2); // repeated healthy probes do not re-report
  assert.equal(prober.historyFor('bot-1').length, 2);
  prober.unregister('bot-2');
  assert.deepEqual(prober.botIds(), ['bot-1']);
  assert.equal(await prober.probeOne('bot-2'), undefined);
  prober.stop();
});

// --- tools ----------------------------------------------------------------

test('v0.97 tools: harness_health_check / routine_list / webhook_status are read-only and real', async () => {
  const dir = tmpDir('open-bot-h2-tools-');
  const tools = createHarnessV2Tools({ stateDir: dir });
  assert.deepEqual(tools.map((t) => t.definition.name), [
    'harness_health_check',
    'harness_routine_list',
    'harness_webhook_status',
  ]);
  assert.ok(tools.every((t) => t.needsApproval === false));
  const ctx = { workspaceDir: dir, botId: 'bot-1' };
  const byName = Object.fromEntries(tools.map((t) => [t.definition.name, t]));

  const health = await byName.harness_health_check.execute({ botId: 'bot-1' }, ctx);
  assert.match(health, /HEALTHY|DEGRADED|UNHEALTHY|UNKNOWN/);
  assert.match(health, /CPU load/);

  const empty = await byName.harness_routine_list.execute({}, ctx);
  assert.match(empty, /No harness v2 routines yet/);

  const noLog = await byName.harness_webhook_status.execute({}, ctx);
  assert.match(noLog, /No webhook deliveries recorded yet/);

  // Seed a routine + a delivery log, then re-read.
  const { JsonFileRoutineStore } = await import('../packages/core/dist/index.js');
  const store = new JsonFileRoutineStore(dir);
  store.save({
    id: 'r-1', botId: 'bot-1', name: 'Digest', trigger: { kind: 'interval', minutes: 30 },
    action: { kind: 'notify', message: 'hi' }, enabled: true,
    createdAt: '2026-11-13T00:00:00.000Z', updatedAt: '2026-11-13T00:00:00.000Z',
  });
  const listed = await byName.harness_routine_list.execute({}, ctx);
  assert.match(listed, /Digest/);
  assert.match(listed, /every 30 min/);
  const missing = await byName.harness_routine_list.execute({ routineId: 'nope' }, ctx);
  assert.match(missing, /No routine with id "nope"/);

  fs.writeFileSync(
    path.join(dir, 'webhook-deliveries-v2.ndjson'),
    [
      JSON.stringify({ id: 'd1', targetId: 'r-1', verified: true, receivedAt: '2026-11-13T12:00:00.000Z', httpStatus: 202 }),
      JSON.stringify({ id: 'd2', targetId: 'r-1', verified: false, rejectReason: 'bad-signature', receivedAt: '2026-11-13T12:01:00.000Z', httpStatus: 401 }),
      '{broken line',
      '',
    ].join('\n'),
  );
  const status = await byName.harness_webhook_status.execute({}, ctx);
  assert.match(status, /2 total, 1 accepted, 1 rejected/);
  assert.match(status, /bad-signature \(1\)/);

  const badBot = await byName.harness_health_check.execute({ botId: 'bad id!' }, ctx);
  assert.match(badBot, /^Error:/);
});
