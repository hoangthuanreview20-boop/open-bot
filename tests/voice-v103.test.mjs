/**
 * Tests for v1.03 — realtime voice v3 + multimodal (Team T5).
 *
 *   1. Session checkpoints (sessionCheckpoint.ts): media stripping,
 *      validation, memory + file stores (round-trip, corrupt file
 *      quarantine, prune), checkpointer budgets (turns / time /
 *      forced summary+media), restore.
 *   2. Resilience (sessionResilience.ts): reconnect controller
 *      (backoff, budget, terminal, goAway), resilient dialer
 *      (retries then gives up), resume instructions.
 *   3. Media conversation (mediaConversation.ts): WAV stripping,
 *      audio attach validation + mock transcription, video frames,
 *      reference resolution (name / ordinal / keyword, en + vi),
 *      per-item Q&A history, budgeted block, snapshot/restore.
 *   4. Local voice engines (localVoiceEngines.ts): binary probing,
 *      Vosk + Piper + command engines over fake runners, fallback
 *      STT/TTS chains (failover, attempts, total failure), registry
 *      pick order, default registry on this machine.
 *   5. Barge-in v3 (bargeInV3.ts): backchannel transcripts,
 *      backchannel lets the model keep talking, soft interrupt
 *      (duck → confirm / cancel with no phantom measurement),
 *      adaptive grace (repeat-after-grace shrinks the window),
 *      resume prompts.
 *   6. VoiceSessionV3 (voiceSessionV3.ts) on a hand-driven fake
 *      transport: connect folds the media block in, checkpoints
 *      on turns, disconnect checkpoints, resume restores + redials
 *      with resume instructions, backchannel/duck/interrupt
 *      end-to-end, audio media + Q&A, tool handlers.
 *   7. Voice-call tools: twelve tools, the two new definitions
 *      validate, and the v3 handlers serve through the toolset.
 *   8. i18n: all 6 locales carry the 14 `voice.realtime.v3.*`
 *      keys; the panel renders the v3 section.
 *
 * No network, no sound card, no Gemini image call. Run after
 * building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/voice-v103.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SessionCheckpointer,
  MemoryCheckpointStore,
  FileCheckpointStore,
  checkpointMediaItem,
  isVoiceSessionCheckpoint,
  VOICE_CHECKPOINT_VERSION,
} from '../packages/core/dist/voice/sessionCheckpoint.js';
import {
  ReconnectController,
  ResilientDialer,
  buildResumeInstructions,
} from '../packages/core/dist/voice/sessionResilience.js';
import {
  MediaConversation,
  MockAudioTranscriber,
  LocalSttAudioTranscriber,
  stripWavHeader,
  base64ToBytes,
  VOICE_VIDEO_MAX_FRAMES,
} from '../packages/core/dist/voice/mediaConversation.js';
import {
  LocalVoiceEngineRegistry,
  VoskSttEngine,
  PiperTtsEngine,
  CommandSttEngine,
  CommandTtsEngine,
  FallbackSttEngine,
  FallbackTtsEngine,
  createDefaultLocalVoiceRegistry,
  detectLocalVoiceEngines,
  findBinaryOnPath,
} from '../packages/core/dist/voice/localVoiceEngines.js';
import {
  BargeInV3Controller,
  isBackchannelTranscript,
  buildResumePrompt,
} from '../packages/core/dist/voice/bargeInV3.js';
import { VoiceSessionV3 } from '../packages/core/dist/voice/voiceSessionV3.js';
import { LongVoiceSession } from '../packages/core/dist/voice/longSession.js';
import { MockLocalSttEngine, detectLocalStt } from '../packages/core/dist/voice/localStt.js';
import { MockTtsEngine } from '../packages/core/dist/voice/tts.js';
import { MockMediaDescriber } from '../packages/core/dist/voice/mediaContext.js';
import { sinePcm16Frame } from '../packages/core/dist/voice/audio.js';
import { pcm16ToWav } from '../packages/core/dist/voice/dictation.js';
import {
  VOICE_CALL_TOOL_NAMES,
  createVoiceCallToolSet,
  validateVoiceCallArgs,
  getVoiceCallToolDefinition,
} from '../packages/core/dist/voice/callTools.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const pcmB64 = (seconds = 0.1) =>
  Buffer.from(sinePcm16Frame(1600, seconds, 440, 16_000)).toString('base64');

function makeClock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

function makeSources(clock, overrides = {}) {
  const longSession = new LongVoiceSession({ clock: clock.now });
  return {
    sources: {
      sessionId: () => 'sess-1',
      provider: () => 'openai',
      instructions: () => 'Be helpful.',
      turnCount: () => longSession.getStats().totalTurns,
      bargeInCount: () => 0,
      longSession: () => longSession,
      mediaItems: () => [],
      mediaAnswers: () => [],
      bargeInInterrupts: () => 0,
      bargeInIgnored: () => ({}),
      bargeInPartials: () => [],
      ...overrides,
    },
    longSession,
  };
}

function makeCheckpoint(overrides = {}) {
  const { sources, longSession } = makeSources(makeClock());
  longSession.addTurn('user', 'hello there');
  longSession.addTurn('model', 'hi, how can I help?');
  const cp = new SessionCheckpointer({ store: new MemoryCheckpointStore() }).checkpointNow(
    sources,
    'manual',
  );
  return { ...cp, ...overrides };
}

// ---------------------------------------------------------------------------
// 1. Session checkpoints
// ---------------------------------------------------------------------------

test('v103 checkpoint: media items strip bytes but keep descriptions', () => {
  const item = {
    id: 'media-1',
    kind: 'image',
    mimeType: 'image/png',
    name: 'shot.png',
    caption: 'the error',
    base64: b64('fake-png-bytes'),
    description: 'A screenshot of an error dialog.',
    describedAt: 1234,
    status: 'described',
    addedAt: 1000,
  };
  const stripped = checkpointMediaItem(item);
  assert.equal(stripped.base64, undefined);
  assert.equal(stripped.bytesOmitted, true);
  assert.equal(stripped.description, 'A screenshot of an error dialog.');
  assert.equal(stripped.status, 'described');
  const noBytes = checkpointMediaItem({ ...item, base64: undefined });
  assert.equal(noBytes.bytesOmitted, false);
});

test('v103 checkpoint: validation refuses wrong version / session / shape', () => {
  const cp = makeCheckpoint();
  assert.equal(isVoiceSessionCheckpoint(cp), true);
  assert.equal(isVoiceSessionCheckpoint(cp, 'sess-1'), true);
  assert.equal(isVoiceSessionCheckpoint(cp, 'other'), false);
  assert.equal(isVoiceSessionCheckpoint({ ...cp, version: 99 }), false);
  assert.equal(isVoiceSessionCheckpoint({ ...cp, longSession: null }), false);
  assert.equal(isVoiceSessionCheckpoint({ ...cp, media: { items: [] } }), false);
  assert.equal(isVoiceSessionCheckpoint(null), false);
  assert.equal(isVoiceSessionCheckpoint('nope'), false);
});

test('v103 checkpoint: memory store round-trips, lists newest first, prunes', () => {
  const store = new MemoryCheckpointStore();
  const clock = makeClock();
  const { sources } = makeSources(clock);
  const checkpointer = new SessionCheckpointer({ store, clock: clock.now });
  const first = checkpointer.checkpointNow(sources, 'manual');
  assert.ok(first);
  assert.equal(first.seq, 1);
  clock.advance(1000);
  const second = checkpointer.checkpointNow(sources, 'turn');
  assert.equal(second.seq, 2);
  const loaded = store.load('sess-1');
  assert.equal(loaded.seq, 2);
  assert.deepEqual(store.list().map((c) => c.sessionId), ['sess-1']);
  assert.equal(store.delete('sess-1'), true);
  assert.equal(store.load('sess-1'), null);
  assert.equal(store.delete('sess-1'), false);
  assert.equal(store.save({ version: 99 }), false);

  // Prune by age: an old checkpoint goes, a fresh one stays.
  const old = { ...makeCheckpoint(), sessionId: 'old-1', createdAt: 1 };
  const fresh = { ...makeCheckpoint(), sessionId: 'new-1', createdAt: Date.now() };
  assert.equal(store.save(old), true);
  assert.equal(store.save(fresh), true);
  const dropped = store.prune(1000, 50);
  assert.equal(dropped, 1);
  assert.equal(store.load('old-1'), null);
  assert.ok(store.load('new-1'));
});

test('v103 checkpoint: file store round-trips, quarantines corrupt files, prunes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-v103-ckpt-'));
  try {
    const store = new FileCheckpointStore({ dir });
    const cp = makeCheckpoint();
    assert.equal(store.save(cp), true);
    const loaded = store.load('sess-1');
    assert.equal(loaded.seq, cp.seq);
    assert.equal(loaded.longSession.turns.length, 2);
    assert.equal(store.list().length, 1);

    // Corrupt the file: load refuses it and quarantines it.
    fs.writeFileSync(path.join(dir, 'sess-1.json'), '{not json', 'utf8');
    assert.equal(store.load('sess-1'), null);
    const names = fs.readdirSync(dir);
    assert.ok(names.some((n) => n.startsWith('sess-1.json.corrupt-')));
    assert.equal(store.list().length, 0);

    // Prune by age + count.
    const fresh = { ...makeCheckpoint(), sessionId: 'fresh-1', createdAt: Date.now() };
    assert.equal(store.save(fresh), true);
    const oldFile = path.join(dir, 'old-1.json');
    fs.writeFileSync(oldFile, JSON.stringify({ ...makeCheckpoint(), sessionId: 'old-1' }), 'utf8');
    const ancient = Date.now() - 40 * 24 * 60 * 60 * 1000;
    fs.utimesSync(oldFile, new Date(ancient), new Date(ancient));
    const dropped = store.prune(30 * 24 * 60 * 60 * 1000, 50);
    assert.equal(dropped, 1);
    assert.equal(fs.existsSync(oldFile), false);
    assert.ok(store.load('fresh-1'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v103 checkpoint: checkpointer budgets — turns, time, forced reasons', () => {
  const clock = makeClock();
  const { sources, longSession } = makeSources(clock);
  const store = new MemoryCheckpointStore();
  const checkpointer = new SessionCheckpointer({
    store,
    everyTurns: 2,
    everyMs: 60_000,
    clock: clock.now,
  });
  // 1 turn: not due.
  longSession.addTurn('user', 'one');
  assert.equal(checkpointer.maybeCheckpoint(sources, 'turn'), null);
  // 2 turns: due by the turn budget.
  longSession.addTurn('model', 'two');
  const cp = checkpointer.maybeCheckpoint(sources, 'turn');
  assert.ok(cp);
  assert.equal(cp.reason, 'turn');
  assert.equal(cp.turnCount, 2);
  // Same turn count again: skipped, not rewritten.
  assert.equal(checkpointer.maybeCheckpoint(sources, 'turn'), null);
  assert.equal(checkpointer.getStats().skippedNoChange, 1);
  // Summary + media always checkpoint, whatever the budgets say.
  assert.ok(checkpointer.maybeCheckpoint(sources, 'summary'));
  assert.ok(checkpointer.maybeCheckpoint(sources, 'media'));
  assert.equal(checkpointer.getStats().checkpoints, 3);

  // Time budget: a fresh checkpointer with a wide turn budget
  // checkpoints when the clock passes everyMs with new turns.
  const clock2 = makeClock();
  const made2 = makeSources(clock2);
  const checkpointer2 = new SessionCheckpointer({
    store: new MemoryCheckpointStore(),
    everyTurns: 100,
    everyMs: 1000,
    clock: clock2.now,
  });
  made2.longSession.addTurn('user', 'first');
  assert.ok(checkpointer2.checkpointNow(made2.sources, 'manual'));
  clock2.advance(500);
  made2.longSession.addTurn('model', 'second');
  assert.equal(checkpointer2.maybeCheckpoint(made2.sources, 'turn'), null);
  clock2.advance(600);
  assert.ok(checkpointer2.maybeCheckpoint(made2.sources, 'turn'));
});

test('v103 checkpoint: restore refuses other sessions, reset clears counters', () => {
  const clock = makeClock();
  const { sources } = makeSources(clock);
  const checkpointer = new SessionCheckpointer({ clock: clock.now });
  const cp = checkpointer.checkpointNow(sources, 'manual');
  assert.ok(cp);
  assert.equal(checkpointer.restore('sess-1').seq, 1);
  assert.equal(checkpointer.restore('nope'), null);
  assert.equal(checkpointer.restore(''), null);
  checkpointer.reset();
  assert.equal(checkpointer.getStats().checkpoints, 0);
});

// ---------------------------------------------------------------------------
// 2. Resilience
// ---------------------------------------------------------------------------

test('v103 resilience: backoff grows, budget exhausts, terminal gives up at once', () => {
  const clock = makeClock();
  const events = [];
  const controller = new ReconnectController({
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 10_000,
    jitter: 0,
    clock: clock.now,
    onEvent: (e) => events.push(e),
  });
  assert.equal(controller.getState(), 'connected');
  const first = controller.noteDisconnected(new Error('socket closed'));
  assert.equal(first.retry, true);
  assert.equal(first.delayMs, 1000);
  assert.equal(first.attempt, 1);
  const second = controller.noteDisconnected(new Error('socket closed'));
  assert.equal(second.delayMs, 2000);
  const third = controller.noteDisconnected(new Error('socket closed'));
  assert.equal(third.delayMs, 4000);
  const fourth = controller.noteDisconnected(new Error('socket closed'));
  assert.equal(fourth.retry, false);
  assert.equal(controller.getState(), 'exhausted');
  assert.equal(controller.getStats().drops, 1);
  assert.equal(controller.getStats().attempts, 3);
  assert.equal(events.filter((e) => e.kind === 'reconnecting').length, 3);
  assert.equal(events.filter((e) => e.kind === 'exhausted').length, 1);

  // Terminal errors never retry.
  const terminal = new ReconnectController({
    maxAttempts: 5,
    jitter: 0,
    clock: clock.now,
  });
  const decision = terminal.noteDisconnected(new Error('401 unauthorized'), { terminal: true });
  assert.equal(decision.retry, false);
  assert.equal(terminal.getState(), 'exhausted');

  // A successful reconnect resets the budget and counts downtime.
  const ok = new ReconnectController({ maxAttempts: 5, jitter: 0, clock: clock.now });
  ok.noteDisconnected(new Error('drop'));
  clock.advance(2500);
  ok.noteConnected();
  assert.equal(ok.getState(), 'connected');
  assert.equal(ok.getStats().reconnects, 1);
  assert.equal(ok.getStats().totalDowntimeMs, 2500);
  assert.equal(ok.getStats().attempts, 0);
});

test('v103 resilience: goAway is a planned reconnect, budget untouched', () => {
  const controller = new ReconnectController({ maxAttempts: 2, jitter: 0 });
  assert.equal(controller.noteGoAway(10), 500);
  assert.equal(controller.noteGoAway(300), 2000);
  assert.equal(controller.noteGoAway(null), 500);
  assert.equal(controller.getStats().attempts, 0);
  assert.equal(controller.getState(), 'connected');
});

test('v103 resilience: dialer retries then succeeds, and gives up when exhausted', async () => {
  const slept = [];
  const sleep = async (ms) => {
    slept.push(ms);
  };
  const dialer = new ResilientDialer({
    controller: new ReconnectController({ maxAttempts: 5, baseDelayMs: 100, jitter: 0 }),
    sleep,
  });
  let calls = 0;
  const result = await dialer.dialWithReconnect(async () => {
    calls += 1;
    if (calls < 3) throw new Error(`drop ${calls}`);
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.deepEqual(slept, [100, 200]);
  assert.equal(result.waitedMs, 300);

  // Exhaustion: the dialer stops after the budget, not forever.
  const slept2 = [];
  const dialer2 = new ResilientDialer({
    controller: new ReconnectController({ maxAttempts: 2, baseDelayMs: 50, jitter: 0 }),
    sleep: async (ms) => {
      slept2.push(ms);
    },
  });
  let calls2 = 0;
  const failed = await dialer2.dialWithReconnect(async () => {
    calls2 += 1;
    throw new Error('still down');
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.attempts, 3); // 1 initial + 2 retries
  assert.match(failed.error, /still down/);
  assert.deepEqual(slept2, [50, 100]);

  // Terminal errors stop at once, with no sleep.
  const slept3 = [];
  const dialer3 = new ResilientDialer({
    controller: new ReconnectController({ maxAttempts: 5, baseDelayMs: 50, jitter: 0 }),
    sleep: async (ms) => {
      slept3.push(ms);
    },
  });
  const terminal = await dialer3.dialWithReconnect(
    async () => {
      throw new Error('401 unauthorized');
    },
    { isTerminalError: (e) => /401/.test(e.message) },
  );
  assert.equal(terminal.ok, false);
  assert.equal(terminal.attempts, 1);
  assert.deepEqual(slept3, []);
});

test('v103 resilience: resume instructions carry context + media + the resume note', () => {
  const cp = makeCheckpoint();
  const text = buildResumeInstructions('Be helpful.', cp, {
    contextBlock: 'Recent turns:\nUser: hello there',
    mediaBlock: 'Attached media:\n[1] image "shot.png": a screenshot.',
  });
  assert.match(text, /Be helpful\./);
  assert.match(text, /hello there/);
  assert.match(text, /shot\.png/);
  assert.match(text, /was interrupted/);
  assert.match(text, /do not restart it/);
  // Empty sections degrade gracefully.
  const bare = buildResumeInstructions('', cp, {});
  assert.match(bare, /was interrupted/);
});

// ---------------------------------------------------------------------------
// 3. Media conversation
// ---------------------------------------------------------------------------

test('v103 media: WAV header stripping is pure and honest', () => {
  const pcm = sinePcm16Frame(1600, 0.1, 440, 16_000);
  const wav = pcm16ToWav(pcm, 16_000);
  assert.equal(wav.length, pcm.length + 44);
  const stripped = stripWavHeader(wav);
  assert.ok(stripped);
  assert.deepEqual(Buffer.from(stripped), Buffer.from(pcm));
  // Plain PCM16 passes through untouched.
  assert.deepEqual(Buffer.from(stripWavHeader(pcm)), Buffer.from(pcm));
  // A RIFF header shorter than 44 bytes is not audio.
  assert.equal(stripWavHeader(new Uint8Array([0x52, 0x49, 0x46, 0x46])), null);
  assert.equal(stripWavHeader(new Uint8Array([1])), null);
  // Invalid base64 throws (the caller reports it).
  assert.throws(() => base64ToBytes('!!!not-base64!!!'), /base64/);
  assert.equal(base64ToBytes(b64('abc')).length, 3);
});

test('v103 media: audio attach refuses mp3 + bad base64, accepts PCM16/WAV', () => {
  const conv = new MediaConversation();
  const mp3 = conv.attachAudio({ mimeType: 'audio/mpeg', base64: pcmB64() });
  assert.equal(mp3.ok, false);
  assert.match(mp3.error, /Only PCM16 \/ WAV/);
  const bad = conv.attachAudio({ mimeType: 'audio/pcm', base64: '!!!' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /base64/);
  const ok = conv.attachAudio({
    mimeType: 'audio/pcm',
    name: 'note.wav',
    caption: 'voice note about the bug',
    durationSec: 4,
    base64: pcmB64(),
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.item.id, 'audio-1');
  assert.equal(ok.item.status, 'pending');
  assert.equal(ok.item.sampleRateHz, 16_000);
  // WAV input has its header stripped and stores as PCM16.
  const wav = conv.attachAudio({
    mimeType: 'audio/wav',
    base64: Buffer.from(pcm16ToWav(sinePcm16Frame(1600, 0.1, 440, 16_000), 16_000)).toString('base64'),
  });
  assert.equal(wav.ok, true);
  assert.equal(wav.item.mimeType, 'audio/pcm');
  assert.equal(conv.listAudio().length, 2);
  assert.equal(conv.removeAudio('audio-1'), true);
  assert.equal(conv.removeAudio('audio-1'), false);
});

test('v103 media: audio transcription via the mock transcriber, failure stays failed', async () => {
  const conv = new MediaConversation({
    audioTranscriber: new MockAudioTranscriber(['the login bug is in auth.ts']),
  });
  const attached = conv.attachAudio({ mimeType: 'audio/pcm', base64: pcmB64() });
  assert.equal(attached.ok, true);
  const done = await conv.transcribeAudio(attached.item.id);
  assert.ok(done);
  assert.equal(done.status, 'transcribed');
  assert.equal(done.transcript, 'the login bug is in auth.ts');
  assert.ok(done.transcribedAt > 0);

  // An empty transcript is a failure, not a silent empty turn.
  const empty = new MediaConversation({
    audioTranscriber: new MockAudioTranscriber([]),
  });
  const attached2 = empty.attachAudio({ mimeType: 'audio/pcm', base64: pcmB64() });
  assert.equal(attached2.ok, true);
  const failed = await empty.transcribeAudio(attached2.item.id);
  assert.equal(failed, null);
  assert.equal(empty.getAudio(attached2.item.id).status, 'failed');
  assert.match(empty.getAudio(attached2.item.id).error, /empty transcript/);

  // The local-STT adapter wraps a real engine (mock engine here).
  const adapter = new LocalSttAudioTranscriber(new MockLocalSttEngine(['via local stt']));
  assert.equal(adapter.name, 'stt:mock-stt');
  assert.equal(await adapter.transcribe(sinePcm16Frame(1600, 0.1, 440, 16_000)), 'via local stt');
  await assert.rejects(adapter.transcribe(new Uint8Array([1])), /PCM16/);
});

test('v103 media: video frames attach, cap, and describe through the describer', async () => {
  const conv = new MediaConversation();
  const video = conv.attach({
    kind: 'video',
    mimeType: 'video/mp4',
    name: 'demo.mp4',
    durationSec: 30,
  });
  assert.equal(video.ok, true);
  const videoId = video.item.id;
  assert.deepEqual(conv.attachVideoFrames('no-such-video', []), {
    ok: false,
    error: 'No attached video with id no-such-video.',
  });
  const badTime = conv.attachVideoFrames(videoId, [
    { atSec: -1, base64: b64('frame'), mimeType: 'image/png' },
  ]);
  assert.equal(badTime.ok, false);
  assert.match(badTime.error, /timestamp/);
  const added = conv.attachVideoFrames(videoId, [
    { atSec: 5, base64: b64('frame-one'), mimeType: 'image/png', caption: 'the chart' },
    { atSec: 12, base64: b64('frame-two'), mimeType: 'image/png' },
  ]);
  assert.deepEqual(added, { ok: true, count: 2 });
  assert.equal(conv.listVideoFrames(videoId).length, 2);
  assert.equal(conv.listVideoFrames(videoId)[0].atSec, 5);
  // Over the cap is refused, not silently dropped.
  const many = Array.from({ length: VOICE_VIDEO_MAX_FRAMES }, (_, i) => ({
    atSec: 20 + i,
    base64: b64(`f${i}`),
    mimeType: 'image/png',
  }));
  assert.equal(conv.attachVideoFrames(videoId, many).ok, false);
  // The mock describer describes frames from their captions.
  const described = await conv.describeVideoFrames(videoId);
  assert.equal(described, 2);
  const frames = conv.listVideoFrames(videoId);
  assert.equal(frames[0].status, 'described');
  assert.match(frames[0].description, /the chart/);
});

test('v103 media: references resolve by name, ordinal, and keyword (en + vi)', () => {
  const conv = new MediaConversation();
  const first = conv.attach({
    kind: 'image', mimeType: 'image/png', name: 'error.png', caption: 'screenshot of the error', base64: b64('one'),
  });
  const second = conv.attach({
    kind: 'image', mimeType: 'image/png', name: 'chart.png', caption: 'the chart', base64: b64('two'),
  });
  const video = conv.attach({ kind: 'video', mimeType: 'video/mp4', name: 'demo.mp4' });
  const audio = conv.attachAudio({ mimeType: 'audio/pcm', name: 'note.wav', base64: pcmB64() });
  assert.ok(first.ok && second.ok && video.ok && audio.ok);

  // Name match beats everything (high confidence).
  assert.deepEqual(conv.resolveReference('what does error.png show?'), {
    itemId: 'media-1', kind: 'image', confidence: 'high', match: 'name',
  });
  // Ordinals pick by kind (medium confidence).
  assert.equal(conv.resolveReference('look at the second image').itemId, 'media-2');
  assert.equal(conv.resolveReference('look at the second image').match, 'ordinal');
  assert.equal(conv.resolveReference('xem ảnh thứ hai').itemId, 'media-2');
  assert.equal(conv.resolveReference('the first image').itemId, 'media-1');
  assert.equal(conv.resolveReference('media 2').itemId, 'media-2');
  // Keywords pick the most recent of the kind.
  assert.equal(conv.resolveReference('look at this photo').itemId, 'media-2');
  assert.equal(conv.resolveReference('look at this photo').confidence, 'low');
  assert.equal(conv.resolveReference('xem video này').itemId, 'media-3');
  assert.equal(conv.resolveReference('listen to this recording').itemId, 'audio-1');
  assert.equal(conv.resolveReference('nghe đoạn ghi âm này').itemId, 'audio-1');
  // "the screenshot" prefers the item actually called a screenshot.
  assert.equal(conv.resolveReference('show me the screenshot').itemId, 'media-1');
  assert.equal(conv.resolveReference('show me the screenshot').confidence, 'high');
  // Nothing attached matches → null, never a guess.
  assert.equal(conv.resolveReference('tell me about the weather'), null);
  assert.equal(conv.resolveReference(''), null);
  assert.equal(new MediaConversation().resolveReference('this photo'), null);
  // linkTurnToMedia feeds the long-session turn.
  assert.deepEqual(conv.linkTurnToMedia('the second image shows a spike'), ['media-2']);
  assert.deepEqual(conv.linkTurnToMedia('hello there'), []);
});

test('v103 media: Q&A history follows up per item; audio answers from the transcript', async () => {
  const conv = new MediaConversation({
    audioTranscriber: new MockAudioTranscriber(['the bug is in auth.ts']),
  });
  const attached = conv.attachAudio({ mimeType: 'audio/pcm', name: 'note.wav', base64: pcmB64() });
  assert.equal(attached.ok, true);
  // Asking before transcribing says so, honestly.
  const early = await conv.askAboutMedia('what does it say?', attached.item.id);
  assert.ok(early);
  assert.match(early.answer, /not been transcribed yet/);
  assert.equal(early.confidence, 'low');
  await conv.transcribeAudio(attached.item.id);
  const first = await conv.askAboutMedia('what does it say?', attached.item.id);
  assert.ok(first);
  assert.match(first.answer, /auth\.ts/);
  assert.equal(first.confidence, 'medium');
  const second = await conv.askAboutMedia('and which file was that?', attached.item.id);
  assert.ok(second);
  assert.match(second.answer, /Earlier questions about this recording: 2/);
  const history = conv.getItemHistory(attached.item.id);
  assert.equal(history.length, 3);
  assert.equal(history[0].question, 'what does it say?');

  // Image Q&A goes through the mock describer and is recorded too.
  const image = conv.attach({
    kind: 'image', mimeType: 'image/png', name: 'shot.png', caption: 'the error dialog', base64: b64('img'),
  });
  assert.equal(image.ok, true);
  const answer = await conv.askAboutMedia('what is in this photo?');
  assert.ok(answer);
  assert.equal(answer.itemId, image.item.id);
  assert.equal(conv.getItemHistory(image.item.id).length, 1);
  assert.equal(await conv.askAboutMedia(''), null);
  // With no item id, the most recently attached item is used.
  const latest = await conv.askAboutMedia('anything else?');
  assert.ok(latest);
  assert.equal(latest.itemId, image.item.id);
});

test('v103 media: conversation block is budgeted, snapshot/restore keeps transcripts', async () => {
  const conv = new MediaConversation({
    audioTranscriber: new MockAudioTranscriber(['a'.repeat(300)]),
    budgetChars: 400,
  });
  const image = conv.attach({
    kind: 'image', mimeType: 'image/png', name: 'big.png', caption: 'the big chart', base64: b64('img'),
  });
  assert.equal(image.ok, true);
  await conv.describeMedia(image.item.id);
  const audio = conv.attachAudio({ mimeType: 'audio/pcm', name: 'note.wav', base64: pcmB64() });
  assert.equal(audio.ok, true);
  await conv.transcribeAudio(audio.item.id);
  const block = conv.buildConversationBlock();
  assert.ok(block.length <= 400, `block is ${block.length} chars, over the 400 budget`);
  assert.match(block, /the big chart/);
  assert.match(block, /note\.wav/);

  const snap = conv.snapshot();
  assert.equal(snap.audio[0].bytesOmitted, true);
  assert.equal(snap.audio[0].transcript.length, 300);
  assert.equal(snap.media[0].bytesOmitted, true);
  const restored = new MediaConversation();
  assert.equal(restored.restore(snap), true);
  assert.equal(restored.listMedia().length, 1);
  assert.equal(restored.listMedia()[0].description, conv.listMedia()[0].description);
  assert.equal(restored.listAudio().length, 1);
  assert.equal(restored.listAudio()[0].transcript.length, 300);
  assert.equal(restored.listAudio()[0].base64, undefined);
  assert.equal(restored.restore({ nope: true }), false);
  assert.equal(restored.restore(null), false);
});

// ---------------------------------------------------------------------------
// 4. Local voice engines
// ---------------------------------------------------------------------------

test('v103 engines: binary probing reads PATH, nothing else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-v103-bin-'));
  try {
    const fake = path.join(dir, 'my-stt');
    fs.writeFileSync(fake, '#!/bin/sh\necho hi\n', 'utf8');
    fs.chmodSync(fake, 0o755);
    assert.equal(findBinaryOnPath('my-stt', dir), fake);
    assert.equal(findBinaryOnPath('no-such-binary', dir), null);
    assert.equal(findBinaryOnPath('my-stt', ''), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const fakeRunner = (stdout, code = 0) => async () => ({ stdout, stderr: '', code });
const recordingRunner = (handlers) => async (command, args, opts) => {
  for (const handle of handlers) {
    const result = await handle(command, args, opts);
    if (result) return result;
  }
  return { stdout: '', stderr: '', code: 0 };
};

test('v103 engines: Vosk transcribes JSON over a fake runner, fails loudly otherwise', async () => {
  const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-v103-vosk-'));
  try {
    const missing = new VoskSttEngine({ binaryPath: '/usr/bin/vosk-transcriber', modelPath: '/no-such-model' });
    assert.equal(missing.isAvailable(), false);
    assert.match(missing.status().reason, /model/);
    const noBinary = new VoskSttEngine({ binaryPath: null, modelPath: modelDir });
    assert.equal(noBinary.isAvailable(), false);
    assert.match(noBinary.status().reason, /vosk-transcriber/);

    const engine = new VoskSttEngine({
      binaryPath: '/usr/bin/vosk-transcriber',
      modelPath: modelDir,
      runner: fakeRunner(JSON.stringify({ text: 'hello vosk' })),
    });
    assert.equal(engine.isAvailable(), true);
    const text = await engine.transcribe(sinePcm16Frame(1600, 0.1, 440, 16_000));
    assert.equal(text, 'hello vosk');
    const failing = new VoskSttEngine({
      binaryPath: '/usr/bin/vosk-transcriber',
      modelPath: modelDir,
      runner: async () => ({ stdout: '', stderr: 'boom', code: 1 }),
    });
    await assert.rejects(failing.transcribe(sinePcm16Frame(1600, 0.1, 440, 16_000)), /code 1/);
    await assert.rejects(engine.transcribe(new Uint8Array([1])), /PCM16/);
  } finally {
    fs.rmSync(modelDir, { recursive: true, force: true });
  }
});

test('v103 engines: Piper synthesises then plays, and says why when it cannot', async () => {
  const modelFile = path.join(os.tmpdir(), `open-bot-v103-piper-${Date.now()}.onnx`);
  fs.writeFileSync(modelFile, 'fake-model');
  try {
    const noModel = new PiperTtsEngine({ binaryPath: '/usr/bin/piper', modelPath: '/no-such-model.onnx' });
    assert.equal(await noModel.isAvailable(), false);
    assert.deepEqual(await noModel.speak('hello'), {
      spoken: false,
      engineId: 'piper',
      reason: 'no Piper voice model (.onnx) found (set PIPER_MODEL_PATH)',
    });
    assert.deepEqual(await noModel.speak('   '), { spoken: false, engineId: 'piper', reason: 'empty-text' });

    const calls = [];
    const runner = recordingRunner([
      async (command, args) => {
        calls.push([command, ...args]);
        const outIdx = args.indexOf('--output_file');
        if (outIdx >= 0) fs.writeFileSync(args[outIdx + 1], 'RIFFfake-wav');
        return { stdout: '', stderr: '', code: 0 };
      },
    ]);
    const engine = new PiperTtsEngine({
      binaryPath: '/usr/bin/piper',
      modelPath: modelFile,
      playerBinary: '/usr/bin/aplay',
      runner,
    });
    assert.equal(await engine.isAvailable(), true);
    const result = await engine.speak('hello piper');
    assert.equal(result.spoken, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], '/usr/bin/piper');
    assert.equal(calls[1][0], '/usr/bin/aplay');
  } finally {
    fs.unlinkSync(modelFile);
  }
});

test('v103 engines: command engines run argv-only over the injected runner', async () => {
  const stt = new CommandSttEngine({
    id: 'my-stt',
    command: 'node',
    args: ['--wav', '{wav}'],
    runner: fakeRunner('hello command'),
  });
  assert.equal(stt.isAvailable(), true);
  assert.equal(await stt.transcribe(sinePcm16Frame(1600, 0.1, 440, 16_000)), 'hello command');
  const jsonStt = new CommandSttEngine({
    id: 'json-stt',
    command: 'node',
    parse: 'json-text',
    runner: fakeRunner(JSON.stringify({ text: 'from json' })),
  });
  assert.equal(await jsonStt.transcribe(sinePcm16Frame(1600, 0.1, 440, 16_000)), 'from json');
  const failing = new CommandSttEngine({
    id: 'bad-stt',
    command: 'node',
    runner: async () => ({ stdout: '', stderr: 'nope', code: 3 }),
  });
  await assert.rejects(failing.transcribe(sinePcm16Frame(1600, 0.1, 440, 16_000)), /code 3/);
  const missing = new CommandSttEngine({ id: 'gone', command: 'definitely-not-a-binary-xyz' });
  assert.equal(missing.isAvailable(), false);

  const tts = new CommandTtsEngine({
    id: 'my-tts',
    command: 'node',
    args: ['speak', '{text}'],
    runner: fakeRunner(''),
  });
  assert.equal(await tts.isAvailable(), true);
  assert.deepEqual(await tts.speak('hello'), { spoken: true, engineId: 'my-tts' });
  assert.deepEqual(await tts.speak('  '), { spoken: false, engineId: 'my-tts', reason: 'empty-text' });
});

test('v103 engines: fallback STT tries in order, records attempts, never guesses', async () => {
  const failing = {
    id: 'boom-stt',
    isAvailable: () => true,
    status: () => ({ available: true, engineId: 'boom-stt', binaryPath: null, modelPath: null }),
    transcribe: async () => {
      throw new Error('engine exploded');
    },
  };
  const mock = new MockLocalSttEngine(['fallback heard']);
  const chain = new FallbackSttEngine([failing, mock]);
  assert.deepEqual(chain.chainIds(), ['boom-stt', 'mock-stt']);
  assert.equal(chain.isAvailable(), true);
  const text = await chain.transcribe(sinePcm16Frame(1600, 0.1, 440, 16_000));
  assert.equal(text, 'fallback heard');
  assert.equal(chain.getFallbacksUsed(), 1);
  assert.equal(chain.lastWorkingEngineId(), 'mock-stt');
  const attempts = chain.getAttempts();
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].ok, false);
  assert.match(attempts[0].error, /exploded/);
  assert.equal(attempts[1].ok, true);

  const allFail = new FallbackSttEngine([failing]);
  await assert.rejects(
    allFail.transcribe(sinePcm16Frame(1600, 0.1, 440, 16_000)),
    /all local STT engines failed.*boom-stt: engine exploded/,
  );
  const none = new FallbackSttEngine([]);
  assert.equal(none.isAvailable(), false);
  assert.match(none.status().reason, /tried: none/);
  await assert.rejects(none.transcribe(sinePcm16Frame(1600, 0.1, 440, 16_000)), /no engines configured/);
});

test('v103 engines: fallback TTS tries in order, reports the whole chain on failure', async () => {
  const unavailable = new MockTtsEngine();
  unavailable.isAvailable = async () => false;
  const mock = new MockTtsEngine();
  const chain = new FallbackTtsEngine([unavailable, mock]);
  const spoken = await chain.speak('hello there');
  assert.equal(spoken.spoken, true);
  assert.equal(chain.getFallbacksUsed(), 1);
  assert.equal(chain.lastWorkingEngineId(), 'mock');
  assert.equal(chain.getAttempts().length, 2);

  const silent = new MockTtsEngine();
  silent.speak = async () => ({ spoken: false, engineId: 'mock', reason: 'no-engine-available' });
  const allFail = new FallbackTtsEngine([silent]);
  const result = await allFail.speak('hello');
  assert.equal(result.spoken, false);
  assert.match(result.reason, /all TTS engines failed.*mock: no-engine-available/);
  assert.equal(await allFail.speak('  ').then((r) => r.reason), 'empty-text');
});

test('v103 engines: registry prefers ids, probes honestly on this machine', async () => {
  const registry = new LocalVoiceEngineRegistry();
  registry.register({
    id: 'a-stt', kind: 'stt', label: 'A', priority: 10,
    probe: () => ({ id: 'a-stt', kind: 'stt', label: 'A', available: true, reason: null, binaryPath: null, modelPath: null }),
    createStt: () => new MockLocalSttEngine(['a']),
  });
  registry.register({
    id: 'b-stt', kind: 'stt', label: 'B', priority: 5,
    probe: () => ({ id: 'b-stt', kind: 'stt', label: 'B', available: true, reason: null, binaryPath: null, modelPath: null }),
    createStt: () => new MockLocalSttEngine(['b']),
  });
  registry.register({
    id: 'off-stt', kind: 'stt', label: 'Off', priority: 1,
    probe: () => ({ id: 'off-stt', kind: 'stt', label: 'Off', available: false, reason: 'missing', binaryPath: null, modelPath: null }),
  });
  // Priority order without preference: b (5) before a (10); off is skipped.
  assert.deepEqual((await registry.pickChain('stt')).map((d) => d.id), ['b-stt', 'a-stt']);
  // A preferred id jumps the queue; unknown ids are ignored.
  assert.deepEqual((await registry.pickChain('stt', ['a-stt', 'nope'])).map((d) => d.id), ['a-stt', 'b-stt']);
  const fallback = await registry.createFallbackStt(['a-stt']);
  assert.equal(await fallback.transcribe(sinePcm16Frame(1600, 0.1, 440, 16_000)), 'a');
  const probes = await registry.probeAll('stt');
  assert.equal(probes.find((p) => p.id === 'off-stt').available, false);

  // The default registry on this machine: whisper + system TTS are
  // installed, vosk/piper are not, mocks are always available.
  const def = createDefaultLocalVoiceRegistry();
  const defProbes = await def.probeAll();
  const byId = new Map(defProbes.map((p) => [p.id, p]));
  assert.equal(byId.get('mock-stt').available, true);
  assert.equal(byId.get('mock-tts').available, true);
  assert.equal(byId.get('vosk').available, false);
  assert.equal(byId.get('piper').available, false);
  const sttChain = await def.pickChain('stt');
  assert.ok(sttChain.some((d) => d.id === 'mock-stt'));
  if (byId.get('whisper-cli').available) {
    assert.equal(sttChain[0].id, 'whisper-cli');
  }
  const ttsChain = await def.pickChain('tts');
  assert.ok(ttsChain.some((d) => d.id === 'mock-tts'));
  const report = await detectLocalVoiceEngines(def);
  assert.equal(typeof report.probedAt, 'number');
  assert.ok(report.stt.chain.length > 0);
  assert.ok(report.tts.chain.length > 0);
  assert.equal(detectLocalStt().id, 'whisper-cli');
});

// ---------------------------------------------------------------------------
// 5. Barge-in v3
// ---------------------------------------------------------------------------

test('v103 barge-in v3: backchannel transcripts are short affirmations only', () => {
  assert.equal(isBackchannelTranscript('uh-huh'), true);
  assert.equal(isBackchannelTranscript('yeah'), true);
  assert.equal(isBackchannelTranscript('ừ'), true);
  assert.equal(isBackchannelTranscript('đúng rồi'), true);
  assert.equal(isBackchannelTranscript('ok'), true);
  assert.equal(isBackchannelTranscript('I see'), true);
  assert.equal(isBackchannelTranscript('stop talking now'), false);
  assert.equal(isBackchannelTranscript('what did you say about the bug'), false);
  assert.equal(isBackchannelTranscript('yeah yeah yeah yeah'), false);
  assert.equal(isBackchannelTranscript(''), false);
  assert.equal(isBackchannelTranscript(undefined), false);
});

test('v103 barge-in v3: backchannel is noted, the model keeps talking', () => {
  const clock = makeClock();
  const c = new BargeInV3Controller({ clock: clock.now });
  assert.equal(c.noteSpeech('local_vad', { speechMs: 300, transcript: 'uh-huh' }).action, 'ignore');
  c.modelSpeechStarted();
  const decision = c.noteSpeech('local_vad', { speechMs: 300, transcript: 'uh-huh' });
  assert.equal(decision.action, 'backchannel');
  assert.equal(decision.reason, 'backchannel');
  assert.equal(c.getStats().backchannels, 1);
  assert.equal(c.isModelSpeaking(), true);
  assert.equal(c.getStats().interrupts, 0);
  // A real sentence is not a backchannel, even when short.
  const real = c.noteSpeech('local_vad', { speechMs: 300, transcript: 'stop, wait' });
  assert.equal(real.action, 'ignore'); // inside the grace window
  assert.equal(real.reason, 'grace');
  clock.advance(1000);
  const late = c.noteSpeech('local_vad', { speechMs: 2000, transcript: 'stop, wait' });
  assert.equal(late.action, 'interrupt');
  assert.equal(late.reason, 'ok');
});

test('v103 barge-in v3: soft interrupt ducks, then confirms or cancels cleanly', () => {
  const clock = makeClock();
  const c = new BargeInV3Controller({ softInterrupt: true, clock: clock.now });
  c.modelSpeechStarted();
  c.noteModelTranscript('Let me explain the auth flow', false);
  clock.advance(1000);
  const duck = c.noteSpeech('local_vad', { speechMs: 2000 });
  assert.equal(duck.action, 'duck');
  assert.equal(duck.reason, 'ducked');
  assert.equal(c.isDuckPending(), true);
  assert.equal(c.getStats().ducks, 1);
  // The user stopped: cancel the duck — no phantom measurement,
  // no partial turn, the model is still speaking.
  const cancelled = c.confirmDuck(false);
  assert.equal(cancelled.action, 'ignore');
  assert.equal(cancelled.reason, 'duck-cancelled');
  assert.equal(c.getStats().duckCancelled, 1);
  assert.equal(c.getStats().interrupts, 0);
  assert.equal(c.getV2().getBargeInMeasurements().length, 0);
  assert.equal(c.getPartialTurns().length, 0);
  assert.equal(c.isModelSpeaking(), true);
  // The user kept talking: confirm the interrupt.
  clock.advance(100);
  const duck2 = c.noteSpeech('local_vad', { speechMs: 2000 });
  assert.equal(duck2.action, 'duck');
  const confirmed = c.confirmDuck(true);
  assert.equal(confirmed.action, 'interrupt');
  assert.equal(confirmed.reason, 'duck-confirmed');
  assert.equal(c.getStats().duckConfirmed, 1);
  // Finishing the round-trip keeps the partial turn.
  c.cancelSent();
  c.playbackFlushed();
  const done = c.backToListening();
  assert.ok(done.measurement);
  assert.equal(done.partial.text, 'Let me explain the auth flow');
  // Confirming with no duck pending is a plain ignore.
  assert.equal(c.confirmDuck(true).action, 'ignore');
});

test('v103 barge-in v3: soft mode off behaves exactly like v2', () => {
  const clock = makeClock();
  const c = new BargeInV3Controller({ softInterrupt: false, clock: clock.now });
  c.modelSpeechStarted();
  clock.advance(1000);
  assert.equal(c.noteSpeech('manual', { speechMs: 2000 }).action, 'interrupt');
  assert.equal(c.isDuckPending(), false);
});

test('v103 barge-in v3: repeat-after-grace shrinks the grace window', () => {
  const clock = makeClock();
  const c = new BargeInV3Controller({ graceMs: 800, clock: clock.now });
  assert.equal(c.getGraceMs(), 800);
  for (let round = 0; round < 3; round++) {
    c.modelSpeechStarted(); // t=1000, 2000+...
    clock.advance(100);
    const ignored = c.noteSpeech('local_vad', { speechMs: 2000 });
    assert.equal(ignored.reason, 'grace');
    clock.advance(800);
    const interrupted = c.noteSpeech('local_vad', { speechMs: 2000 });
    assert.equal(interrupted.action, 'interrupt');
    c.backToListening();
  }
  assert.equal(c.getStats().repeatAfterGrace, 3);
  assert.equal(c.getStats().graceAdaptations, 1);
  assert.equal(c.getGraceMs(), 700);
  // The grace never shrinks below the floor, however many repeats.
  for (let round = 0; round < 30; round++) {
    c.modelSpeechStarted();
    clock.advance(100);
    c.noteSpeech('local_vad', { speechMs: 2000 });
    clock.advance(800);
    c.noteSpeech('local_vad', { speechMs: 2000 });
    c.backToListening();
  }
  assert.ok(c.getGraceMs() >= 200);
});

test('v103 barge-in v3: resume prompts continue or restart honestly', () => {
  assert.match(
    buildResumePrompt('Let me explain the auth', 'resume'),
    /Continue from exactly where you stopped/,
  );
  assert.match(buildResumePrompt('Let me explain the auth', 'resume'), /Let me explain the auth/);
  assert.match(buildResumePrompt('', 'resume'), /Continue it from the start/);
  assert.match(buildResumePrompt('Let me explain', 'restart'), /Do not repeat it/);
  assert.match(buildResumePrompt('', 'restart'), /Do not repeat it/);
  // A very long partial is trimmed, not pasted whole.
  assert.ok(buildResumePrompt('x'.repeat(1000), 'resume').length < 700);
});

// ---------------------------------------------------------------------------
// 6. VoiceSessionV3 on a hand-driven fake transport
// ---------------------------------------------------------------------------

class FakeTransport {
  constructor(callbacks) {
    this.cb = callbacks;
    this.provider = 'openai';
    this.inputSampleRateHz = 16_000;
    this.outputSampleRateHz = 24_000;
    this.handlesReconnect = true;
    this.connected = false;
    this.cancels = 0;
    this.commits = 0;
  }
  getState() {
    return this.connected ? 'connected' : 'closed';
  }
  isConnected() {
    return this.connected;
  }
  async connect() {
    this.connected = true;
    this.cb.onStateChange?.('connected');
  }
  disconnect() {
    this.connected = false;
    this.cb.onStateChange?.('closed');
  }
  sendAudio() {}
  commitAudio() {
    this.commits += 1;
  }
  requestResponse() {}
  cancelResponse() {
    this.cancels += 1;
  }
  sendToolResult() {}
  emitAudio() {
    this.cb.onAudio?.({ audio: sinePcm16Frame(2400, 0.1, 440, 24_000) });
  }
  emitTranscript(text, isFinal) {
    this.cb.onTranscript?.({ text, isFinal });
  }
  emitResponseDone() {
    this.cb.onResponseDone?.();
  }
  emitSpeechStarted() {
    this.cb.onSpeechStarted?.();
  }
}

function makeV3(events, clock, overrides = {}) {
  let transport = null;
  const v3 = new VoiceSessionV3({
    v2: {
      session: {
        provider: 'openai',
        transportFactory: (cb) => {
          transport = new FakeTransport(cb);
          return transport;
        },
      },
      longSession: { maxContextChars: 10_000 },
    },
    checkpointEveryTurns: 1,
    mediaConversation: {
      audioTranscriber: new MockAudioTranscriber(['the bug is in auth.ts']),
    },
    clock: clock.now,
    onEvent: (e) => events.push(e),
    ...overrides,
  });
  return { v3, getTransport: () => transport };
}

test('v103 session v3: connect folds the media block in, turns checkpoint', async () => {
  const events = [];
  const clock = makeClock();
  const { v3, getTransport } = makeV3(events, clock);
  const attached = v3.attachMedia({
    kind: 'image',
    mimeType: 'image/png',
    name: 'error.png',
    caption: 'screenshot of the error',
    base64: b64('fake-png'),
  });
  assert.equal(attached.ok, true);
  await v3.connect({ instructions: 'You are a helpful voice assistant.' });
  assert.equal(v3.getState(), 'listening');
  const instructions = v3.getSessionInstructions();
  assert.match(instructions, /helpful voice assistant/);
  assert.match(instructions, /screenshot of the error/);

  const t = getTransport();
  t.emitAudio();
  t.emitTranscript('Check the token refresh in auth.ts.', true);
  t.emitResponseDone();
  assert.equal(v3.getLongSessionTurns().length, 1);
  const cp = v3.loadCheckpoint();
  assert.ok(cp);
  assert.equal(cp.provider, 'openai');
  assert.equal(cp.media.items.length, 1);
  assert.equal(cp.media.items[0].bytesOmitted, true);
  assert.ok(events.find((e) => e.kind === 'checkpoint'));
  assert.equal(v3.getCheckpointStats().checkpoints >= 1, true);
  v3.disconnect();
});

test('v103 session v3: disconnect checkpoints, resume restores and redials', async () => {
  const events = [];
  const clock = makeClock();
  const { v3, getTransport } = makeV3(events, clock);
  v3.noteUserTurn('How do I fix the login bug?');
  v3.attachMedia({
    kind: 'image',
    mimeType: 'image/png',
    name: 'error.png',
    caption: 'screenshot of the error',
    base64: b64('fake-png'),
  });
  await v3.connect({ instructions: 'You are a helpful voice assistant.' });
  const t = getTransport();
  t.emitAudio();
  t.emitTranscript('Check the token refresh in auth.ts.', true);
  t.emitResponseDone();
  assert.equal(v3.getLongSessionTurns().length, 2);
  v3.disconnect();
  const stored = v3.loadCheckpoint();
  assert.ok(stored);
  assert.equal(stored.reason, 'disconnect');
  assert.equal(stored.turnCount, 1); // session turn count (one response)
  assert.equal(stored.longSession.turns.length, 2);
  assert.equal(stored.media.items[0].description, '');

  // Resume: the transcript + media survive, the socket is fresh.
  const resumed = await v3.resume();
  assert.ok(resumed);
  assert.equal(v3.getState(), 'listening');
  assert.equal(v3.getLongSessionTurns().length, 2);
  assert.match(v3.getLongSessionTurns()[0].text, /login bug/);
  assert.equal(v3.listMedia().length, 1);
  assert.equal(v3.getV3Stats().resumed, true);
  assert.deepEqual(v3.getV3Stats().restored, { turnCount: 1, bargeInCount: 0 });
  const resumedEvent = events.find((e) => e.kind === 'resumed');
  assert.ok(resumedEvent);
  assert.equal(resumedEvent.attempts, 1);
  // Resuming a live call is a no-op.
  assert.equal(await v3.resume(), null);
  v3.disconnect();
  // Resume with no checkpoint stored is null, not a crash.
  const freshEvents = [];
  const freshClock = makeClock();
  const { v3: fresh } = makeV3(freshEvents, freshClock);
  assert.equal(await fresh.resume(undefined, { instructions: 'hi' }), null);
});

test('v103 session v3: backchannel does not cancel, interrupt keeps the partial', async () => {
  const events = [];
  const clock = makeClock();
  const { v3, getTransport } = makeV3(events, clock);
  await v3.connect({ instructions: 'Be helpful.' });
  const t = getTransport();
  t.emitAudio();
  assert.equal(v3.getState(), 'speaking');
  const back = v3.noteUserSpeechV3('local_vad', { speechMs: 300, transcript: 'uh-huh' });
  assert.equal(back.action, 'backchannel');
  assert.equal(t.cancels, 0);
  assert.equal(v3.getState(), 'speaking');
  assert.ok(events.find((e) => e.kind === 'backchannel'));

  // A real interruption past the grace window cancels + keeps the partial.
  t.emitTranscript('Let me explain the auth flow', false);
  clock.advance(1000);
  const cut = v3.noteUserSpeechV3('local_vad', { speechMs: 2000 });
  assert.equal(cut.action, 'interrupt');
  assert.equal(t.cancels, 1);
  assert.equal(v3.getState(), 'listening');
  const v3Event = events.find((e) => e.kind === 'barge-in-v3');
  assert.ok(v3Event);
  assert.equal(typeof v3Event.measurementMs, 'number');
  assert.equal(v3Event.partialText, 'Let me explain the auth flow');
  const partials = v3.getPartialTurns();
  assert.equal(partials.length, 1);
  assert.equal(partials[0].text, 'Let me explain the auth flow');
  assert.match(v3.buildResumePrompt(), /Continue from exactly where you stopped|Do not repeat it/);
  v3.disconnect();
});

test('v103 session v3: soft duck pauses, then confirms or resumes', async () => {
  const events = [];
  const clock = makeClock();
  const { v3, getTransport } = makeV3(events, clock, {
    bargeInV3: { softInterrupt: true },
  });
  await v3.connect({ instructions: 'Be helpful.' });
  const t = getTransport();
  t.emitAudio();
  clock.advance(1000);
  const duck = v3.noteUserSpeechV3('local_vad', { speechMs: 2000 });
  assert.equal(duck.action, 'duck');
  assert.equal(t.cancels, 0);
  assert.ok(events.find((e) => e.kind === 'ducked'));
  // The user stopped: playback resumes, nothing was cancelled.
  const cancelled = v3.confirmDuck(false);
  assert.equal(cancelled.action, 'ignore');
  assert.equal(t.cancels, 0);
  assert.equal(v3.getState(), 'speaking');
  assert.ok(events.find((e) => e.kind === 'duck-cancelled'));
  // The user kept talking: the interrupt lands.
  clock.advance(100);
  const duck2 = v3.noteUserSpeechV3('local_vad', { speechMs: 2000 });
  assert.equal(duck2.action, 'duck');
  const confirmed = v3.confirmDuck(true);
  assert.equal(confirmed.action, 'interrupt');
  assert.equal(t.cancels, 1);
  assert.equal(v3.getState(), 'listening');
  v3.disconnect();
});

test('v103 session v3: audio media + video frames + Q&A end to end', async () => {
  const events = [];
  const clock = makeClock();
  const { v3 } = makeV3(events, clock);
  const audio = v3.attachAudioMedia({
    mimeType: 'audio/pcm',
    name: 'note.wav',
    caption: 'voice note about the bug',
    base64: pcmB64(),
  });
  assert.equal(audio.ok, true);
  const done = await v3.transcribeAudio(audio.item.id);
  assert.equal(done.status, 'transcribed');
  assert.equal(done.transcript, 'the bug is in auth.ts');
  const answer = await v3.askAboutMedia('what does the recording say?');
  assert.ok(answer);
  assert.match(answer.answer, /auth\.ts/);
  assert.equal(v3.getLongSessionTurns().length, 2); // question + answer turns
  assert.deepEqual(v3.resolveMediaReference('listen to this recording').itemId, 'audio-1');
  assert.deepEqual(v3.linkTurnToMedia('the recording says auth.ts'), ['audio-1']);

  const video = v3.attachMedia({ kind: 'video', mimeType: 'video/mp4', name: 'demo.mp4', durationSec: 30 });
  assert.equal(video.ok, true);
  const frames = v3.attachVideoFrames(video.item.id, [
    { atSec: 5, base64: b64('frame-one'), mimeType: 'image/png', caption: 'the chart' },
  ]);
  assert.equal(frames.ok, true);
  assert.equal(await v3.describeVideoFrames(video.item.id), 1);
  assert.equal(v3.listVideoFrames(video.item.id)[0].status, 'described');
  const stats = v3.getV3Stats();
  assert.equal(stats.media.audio, 1);
  assert.equal(stats.media.videos, 1);
  assert.equal(stats.media.frames, 1);
  assert.ok(stats.media.answers >= 1);
  v3.disconnect();
});

test('v103 session v3: tool handlers save checkpoints and recall media', async () => {
  const events = [];
  const clock = makeClock();
  const { v3 } = makeV3(events, clock);
  v3.attachMedia({
    kind: 'image', mimeType: 'image/png', name: 'error.png', caption: 'screenshot of the error', base64: b64('fake-png'),
  });
  await v3.connect({ instructions: 'Be helpful.' });
  const toolset = createVoiceCallToolSet(v3.createToolHandlers());
  const saved = await toolset.execute('save_checkpoint', { reason: 'user asked' });
  assert.equal(saved.kind, 'served');
  assert.equal(saved.output.saved, true);
  assert.equal(saved.output.seq, 2); // seq 1 was the attach-media checkpoint
  const recalled = await toolset.execute('recall_media', {
    reference: 'this photo',
    question: 'what is in it?',
  });
  assert.equal(recalled.kind, 'served');
  assert.equal(recalled.output.found, true);
  assert.equal(recalled.output.itemId, 'media-1');
  assert.match(recalled.output.answer, /screenshot of the error/);
  const missing = await toolset.execute('recall_media', { reference: 'the weather chart' });
  assert.equal(missing.kind, 'served');
  assert.equal(missing.output.found, false);
  const invalid = await toolset.execute('recall_media', {});
  assert.equal(invalid.kind, 'invalid_input');
  assert.match(invalid.error, /missing required argument "reference"/);
  v3.disconnect();
});

// ---------------------------------------------------------------------------
// 7. Voice-call tools
// ---------------------------------------------------------------------------

test('v103 tools: twelve tools, the two new ones validate', () => {
  assert.equal(VOICE_CALL_TOOL_NAMES.length, 12);
  assert.ok(VOICE_CALL_TOOL_NAMES.includes('save_checkpoint'));
  assert.ok(VOICE_CALL_TOOL_NAMES.includes('recall_media'));
  const save = getVoiceCallToolDefinition('save_checkpoint');
  assert.equal(save.parameters.reason.charLimit, 200);
  assert.equal(save.parameters.reason.required, undefined);
  const recall = getVoiceCallToolDefinition('recall_media');
  assert.equal(recall.parameters.reference.required, true);
  assert.equal(recall.parameters.question.charLimit, 500);
  assert.deepEqual(validateVoiceCallArgs('save_checkpoint', { reason: 'mid-call save' }), {
    ok: true,
    args: { reason: 'mid-call save' },
  });
  assert.deepEqual(validateVoiceCallArgs('save_checkpoint', {}), { ok: true, args: {} });
  assert.equal(validateVoiceCallArgs('recall_media', {}).ok, false);
  assert.equal(validateVoiceCallArgs('recall_media', { reference: 'this photo' }).ok, true);
  assert.equal(validateVoiceCallArgs('recall_media', { reference: 'x', nope: 'y' }).ok, false);
});

// ---------------------------------------------------------------------------
// 8. i18n
// ---------------------------------------------------------------------------

test('v103 i18n: all 6 locales carry the 14 voice.realtime.v3.* keys', () => {
  const locales = ['vi', 'en', 'zh', 'ja', 'es', 'fr'];
  const keys = [
    'voice.realtime.v3.title',
    'voice.realtime.v3.checkpoints',
    'voice.realtime.v3.resumed',
    'voice.realtime.v3.reconnecting',
    'voice.realtime.v3.backchannels',
    'voice.realtime.v3.ducked',
    'voice.realtime.v3.audioMedia',
    'voice.realtime.v3.engines',
    'voice.realtime.v3.checkpointSaved',
    'voice.realtime.v3.graceAdapted',
    'voice.realtime.v3.mediaFrames',
    'voice.realtime.v3.resumePrompt',
    'voice.realtime.v3.noCheckpoint',
    'voice.realtime.v3.fallbackUsed',
  ];
  const parsed = {};
  for (const locale of locales) {
    parsed[locale] = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'apps/desktop/src/renderer/i18n/locales', `${locale}.json`), 'utf8'),
    );
    for (const key of keys) {
      assert.equal(typeof parsed[locale][key], 'string', `${locale} is missing ${key}`);
    }
  }
  for (const key of keys) {
    const values = new Set(locales.map((l) => parsed[l][key]));
    assert.ok(values.size > 1, `${key} is identical in every locale — probably untranslated`);
  }
  // The panel renders the v3 section from the optional v3Status prop.
  const panel = fs.readFileSync(
    path.join(ROOT, 'apps/desktop/src/renderer/components/RealtimeVoicePanel.tsx'),
    'utf8',
  );
  assert.match(panel, /v3Status\?: RealtimeV3Status/);
  assert.match(panel, /data-testid="realtime-v3"/);
  assert.match(panel, /data-testid="realtime-v3-checkpoints"/);
  assert.match(panel, /voice\.realtime\.v3\.checkpoints/);
  assert.match(panel, /voice\.realtime\.v3\.fallbackUsed/);
});
