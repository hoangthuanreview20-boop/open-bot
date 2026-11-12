/**
 * Core tests for v0.83a — TTS stop.
 *
 *   - SystemTtsEngine.stop() SIGKILLs the utterance that is still
 *     speaking (fake slow `espeak-ng` on PATH): the in-flight
 *     speak() promise resolves { spoken: false, reason: 'stopped' },
 *     stop() itself returns true.
 *   - stop() with nothing speaking returns false (system engine and
 *     MockTtsEngine alike); TtsHarness.stop() reports
 *     { stopped: false, engineId: null } then.
 *   - A new speak() replaces one still speaking: the old promise
 *     resolves 'stopped', the new one speaks.
 *   - TtsHarness.stop() delegates to the speaking engine and
 *     reports its id.
 *   - The real engine on this machine (espeak-ng 1.51, installed
 *     v0.82) is covered adaptively: a short utterance speaks, and
 *     stop() after it finishes returns false — the test never
 *     hard-codes "engine present", so it stays green on a machine
 *     without one.
 *
 * Run: npm run build --workspace=@open-bot/core && node --test tests/tts-stop-v083.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MockTtsEngine,
  SystemTtsEngine,
  TtsHarness,
} from '../packages/core/dist/index.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until the fake binary has actually logged `n` calls (i.e. the
 * child runtime really started and ran its first line), instead of
 * sleeping a fixed 300 ms and hoping. Under full-suite load a
 * `#!/usr/bin/env node` child can take longer than 300 ms just to
 * start — a SIGKILL landing before the first line runs leaves
 * `calls()` empty even though the spawn + kill behaviour was correct
 * (that is what failed the replace test in the v0.83 full suite).
 * The slow fake sleeps 30 s, so waiting for its log line is safe.
 */
async function waitForCalls(fake, n, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fake.calls().length >= n) return;
    await sleep(50);
  }
  throw new Error(`fake espeak-ng logged ${fake.calls().length} calls, expected >= ${n}`);
}

/**
 * Fake `espeak-ng` on PATH. `mode: 'slow'` sleeps 30 s (until
 * killed); `mode: 'instant'` exits 0 at once. Every call is logged
 * (argv JSON per line) so the test can count utterances.
 */
function installFakeEspeak(mode) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-tts-v083-'));
  const logFile = path.join(tmpDir, 'calls.log');
  const fakeBin = path.join(tmpDir, 'espeak-ng');
  const body =
    mode === 'slow'
      ? `require('node:fs').appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nsetTimeout(() => {}, 30000);\n`
      : `require('node:fs').appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`;
  fs.writeFileSync(fakeBin, `#!/usr/bin/env node\n${body}`, { mode: 0o755 });
  const origPath = process.env.PATH ?? '';
  process.env.PATH = `${tmpDir}${path.delimiter}${origPath}`;
  return {
    tmpDir,
    logFile,
    cleanup() {
      process.env.PATH = origPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
    calls() {
      try {
        return fs
          .readFileSync(logFile, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
  };
}

test('SystemTtsEngine.stop: kills the speaking utterance, speak resolves stopped', async () => {
  const fake = installFakeEspeak('slow');
  try {
    const engine = new SystemTtsEngine();
    assert.equal(await engine.isAvailable(), true);
    const speaking = engine.speak('A very long answer that keeps on going and going');
    await sleep(300);
    assert.equal(await engine.stop(), true, 'stop() reports something was killed');
    const res = await speaking;
    assert.deepEqual(res, { spoken: false, engineId: 'espeak-ng', reason: 'stopped' });
    // Nothing left to stop now.
    assert.equal(await engine.stop(), false);
  } finally {
    fake.cleanup();
  }
});

test('SystemTtsEngine.stop: false when nothing is speaking', async () => {
  const fake = installFakeEspeak('instant');
  try {
    const engine = new SystemTtsEngine();
    assert.equal(await engine.stop(), false, 'never spoke');
    const res = await engine.speak('Hi');
    assert.equal(res.spoken, true);
    assert.equal(await engine.stop(), false, 'already finished');
  } finally {
    fake.cleanup();
  }
});

test('SystemTtsEngine: a new speak replaces one still speaking', async () => {
  const fake = installFakeEspeak('slow');
  try {
    const engine = new SystemTtsEngine();
    const first = engine.speak('First long utterance that never ends on its own');
    // Wait for the first child to REALLY start (log line written)
    // before replacing it — otherwise the kill can land before the
    // child runtime runs its first line and calls() stays empty.
    await waitForCalls(fake, 1);
    const second = engine.speak('Short');
    const firstRes = await first;
    assert.deepEqual(firstRes, { spoken: false, engineId: 'espeak-ng', reason: 'stopped' });
    // Same for the second child: wait for its log line before
    // stopping it, so the "both utterances spawned" count is real.
    await waitForCalls(fake, 2);
    // The second utterance is still the slow fake — stop it too so
    // the test process does not wait 30 s for the child.
    assert.equal(await engine.stop(), true);
    const secondRes = await second;
    assert.deepEqual(secondRes, { spoken: false, engineId: 'espeak-ng', reason: 'stopped' });
    assert.equal(fake.calls().length, 2, 'both utterances spawned the binary');
  } finally {
    fake.cleanup();
  }
});

test('MockTtsEngine.stop is always false; TtsHarness.stop reports the speaking engine', async () => {
  const mock = new MockTtsEngine();
  const harnessMock = new TtsHarness([mock]);
  assert.deepEqual(await harnessMock.stop(), { stopped: false, engineId: null });
  assert.equal(await mock.stop(), false);

  const fake = installFakeEspeak('slow');
  try {
    const engine = new SystemTtsEngine();
    const harness = new TtsHarness([engine]);
    const speaking = harness.speak('A very long answer that keeps on going and going');
    await sleep(300);
    assert.deepEqual(await harness.stop(), { stopped: true, engineId: 'espeak-ng' });
    assert.deepEqual(await speaking, { spoken: false, engineId: 'espeak-ng', reason: 'stopped' });
    assert.deepEqual(await harness.stop(), { stopped: false, engineId: null });
  } finally {
    fake.cleanup();
  }
});

test('Real engine on this machine: short utterance speaks, stop afterwards is false', async () => {
  const harness = new TtsHarness();
  const status = await harness.status();
  if (!status.available) {
    // Machine without any engine — the honest result, not a failure.
    assert.deepEqual(await harness.speak('Hi'), {
      spoken: false,
      engineId: null,
      reason: 'no-engine-available',
    });
    assert.deepEqual(await harness.stop(), { stopped: false, engineId: null });
    return;
  }
  const res = await harness.speak('Xin chào');
  assert.equal(res.spoken, true, `real engine speaks: ${JSON.stringify(res)}`);
  assert.deepEqual(await harness.stop(), { stopped: false, engineId: null });
});
