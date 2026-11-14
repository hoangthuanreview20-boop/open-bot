/**
 * Tests for v1.02 — realtime voice v2 + multimodal (Team T5).
 *
 *   1. LongVoiceSession (packages/core/src/voice/longSession.ts):
 *      addTurn/stats, extractiveSummary (deterministic), auto
 *      compaction under a small budget, model summarizer + fallback
 *      when it throws, context block shape, snapshot/restore
 *      (incl. corrupt snapshot ignored).
 *   2. BargeInController (bargeInV2.ts): grace window ignores early
 *      speech, sub-threshold speech is a blip, a real interrupt
 *      measures + keeps the partial turn, speech while the model is
 *      silent is ignored, second speech during an interrupt is
 *      ignored, external partials (session server-VAD path).
 *   3. VoiceMediaContext + describers (mediaContext.ts): attach
 *      validation (kind/MIME/base64/size), mock describe + Q&A,
 *      context block, remove/prune, VisionApiDescriber over a fake
 *      fetch (image sent as image_url, HTTP error, empty reply).
 *   4. LocalVoiceStack (localVoiceStack.ts): mock stack transcribes
 *      + speaks + reports mode 'mock'; the real detected stack on
 *      this machine has no whisper binary, so transcribe() throws
 *      a clear error instead of guessing.
 *   5. VoiceSessionV2 (voiceSessionV2.ts) on a hand-driven fake
 *      transport: connect folds the context block into
 *      instructions, final transcripts feed the long session, media
 *      attach + askAboutMedia records turns, manual interrupt past
 *      the grace window cancels + keeps the partial turn, speech
 *      inside the grace window is ignored, server-VAD interrupt
 *      keeps the partial without a v2 measurement.
 *
 * No network, no sound card, no Gemini image call. Run after
 * building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/voice-v102.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LongVoiceSession,
  extractiveSummary,
} from '../packages/core/dist/voice/longSession.js';
import {
  BargeInController,
  BARGE_IN_V2_DEFAULT_GRACE_MS,
} from '../packages/core/dist/voice/bargeInV2.js';
import {
  VoiceMediaContext,
  MockMediaDescriber,
  VisionApiDescriber,
  mediaBytes,
} from '../packages/core/dist/voice/mediaContext.js';
import {
  LocalVoiceStack,
  createMockLocalVoiceStack,
} from '../packages/core/dist/voice/localVoiceStack.js';
import { VoiceSessionV2 } from '../packages/core/dist/voice/voiceSessionV2.js';
import { sinePcm16Frame } from '../packages/core/dist/voice/audio.js';

/** Controllable clock: now() returns `t`, advance() moves it. */
function makeClock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// ---------------------------------------------------------------------------
// 1. LongVoiceSession
// ---------------------------------------------------------------------------

test('v102 long session: turns, stats, context block', () => {
  const s = new LongVoiceSession({ maxContextChars: 10_000 });
  assert.equal(s.addTurn('user', '  '), null);
  const t1 = s.addTurn('user', 'How do I fix the login bug?');
  const t2 = s.addTurn('model', 'Check the token refresh in auth.ts.');
  assert.ok(t1 && t2 && t2.seq === t1.seq + 1);
  const stats = s.getStats();
  assert.equal(stats.totalTurns, 2);
  assert.equal(stats.liveTurns, 2);
  assert.equal(stats.compactions, 0);
  assert.equal(stats.hasSummary, false);
  const block = s.getContextBlock();
  assert.match(block, /Recent turns:/);
  assert.match(block, /User: How do I fix the login bug\?/);
  assert.match(block, /Bot: Check the token refresh/);
});

test('v102 long session: extractive summary is deterministic', () => {
  const turns = [
    { seq: 1, speaker: 'user', text: 'How do I fix the login bug?', at: 1 },
    { seq: 2, speaker: 'model', text: 'Check the token refresh in auth.ts first.', at: 2 },
    { seq: 3, speaker: 'user', text: 'What file is that in?', at: 3 },
    { seq: 4, speaker: 'model', text: 'packages/core/src/auth.ts, line 42.', at: 4 },
  ];
  const a = extractiveSummary(turns);
  const b = extractiveSummary(turns);
  assert.equal(a, b);
  assert.match(a, /User: How do I fix the login bug\?/);
  assert.match(a, /What file is that in\?/);
  assert.equal(extractiveSummary([]), '');
});

test('v102 long session: auto-compacts over budget, keeps recent turns', async () => {
  const events = [];
  const s = new LongVoiceSession({
    maxContextChars: 120,
    keepRecentTurns: 2,
    onEvent: (e) => events.push(e),
  });
  for (let i = 0; i < 8; i++) {
    s.addTurn(i % 2 === 0 ? 'user' : 'model', `Turn number ${i} with some spoken content here.`);
  }
  const stats = s.getStats();
  assert.ok(stats.compactions >= 1, 'expected at least one compaction');
  assert.equal(stats.liveTurns, 2);
  assert.ok(stats.hasSummary);
  assert.ok(s.getContextBlock().includes('Earlier in this call (summarised):'));
  assert.equal(events.filter((e) => e.kind === 'summary').length, stats.compactions);
  // Summary event carries the compacted count.
  assert.ok(events.find((e) => e.kind === 'summary' && e.compactedTurns > 0));
});

test('v102 long session: model summarizer wins, failure falls back to extractive', async () => {
  const model = new LongVoiceSession({
    maxContextChars: 10_000,
    keepRecentTurns: 1,
    summarizer: async () => 'MODEL SUMMARY: login bug discussion.',
  });
  for (let i = 0; i < 4; i++) model.addTurn('user', `Spoken turn ${i} about the login flow.`);
  const summary = await model.compact();
  assert.ok(summary);
  assert.equal(summary.source, 'model');
  assert.match(summary.text, /MODEL SUMMARY/);

  const failing = new LongVoiceSession({
    maxContextChars: 10_000,
    keepRecentTurns: 1,
    summarizer: async () => {
      throw new Error('model down');
    },
  });
  failing.addTurn('user', 'How do I fix the login bug?');
  failing.addTurn('model', 'Check the token refresh.');
  failing.addTurn('user', 'Where is that code?');
  const fallback = await failing.compact();
  assert.ok(fallback);
  assert.equal(fallback.source, 'extractive');
  assert.match(fallback.text, /login bug/);
});

test('v102 long session: snapshot/restore round-trips, corrupt snapshot ignored', () => {
  const s = new LongVoiceSession({ maxContextChars: 120, keepRecentTurns: 1 });
  s.addTurn('user', 'First question about the login bug?');
  s.addTurn('model', 'First answer with some detail here.');
  s.addTurn('user', 'Second question, keep talking please.');
  const snap = s.snapshot();
  const restored = new LongVoiceSession();
  assert.equal(restored.restore(snap), true);
  assert.equal(restored.getStats().totalTurns, s.getStats().totalTurns);
  assert.equal(restored.getContextBlock(), s.getContextBlock());
  assert.equal(restored.restore(null), false);
  assert.equal(restored.restore({ turns: 'nope' }), false);
  assert.equal(restored.restore({ turns: [{ seq: 'x' }], summaries: [] }), true);
  assert.equal(restored.getTurns().length, 0);
});

// ---------------------------------------------------------------------------
// 2. BargeInController
// ---------------------------------------------------------------------------

test('v102 barge-in v2: grace window, blips, and silence are ignored', () => {
  const clock = makeClock();
  const c = new BargeInController({ clock: clock.now });
  assert.equal(c.noteSpeech('manual').action, 'ignore'); // not speaking
  assert.equal(c.noteSpeech('manual').reason, 'not-speaking');
  c.modelSpeechStarted(); // t=1000
  clock.advance(100);
  const grace = c.noteSpeech('server_vad', { speechMs: 500 });
  assert.equal(grace.action, 'ignore');
  assert.equal(grace.reason, 'grace');
  clock.advance(BARGE_IN_V2_DEFAULT_GRACE_MS);
  const blip = c.noteSpeech('local_vad', { speechMs: 50 });
  assert.equal(blip.action, 'ignore');
  assert.equal(blip.reason, 'too-short');
  assert.deepEqual(c.getIgnoredCounts().grace, 1);
  assert.deepEqual(c.getIgnoredCounts()['too-short'], 1);
});

test('v102 barge-in v2: real interrupt measures and keeps the partial turn', () => {
  const clock = makeClock();
  const c = new BargeInController({ clock: clock.now, resumePolicy: 'resume' });
  c.modelSpeechStarted();
  c.noteModelTranscript('Hello there, let me explain the', false);
  clock.advance(1500);
  const d = c.noteSpeech('manual', { speechMs: 400 });
  assert.equal(d.action, 'interrupt');
  assert.equal(d.reason, 'ok');
  assert.equal(d.resumePolicy, 'resume');
  assert.equal(d.speechAtMs, 1500);
  // Second speech while interrupting is ignored, not double-measured.
  assert.equal(c.noteSpeech('manual').reason, 'already-interrupting');
  c.cancelSent();
  c.playbackFlushed();
  const done = c.backToListening();
  assert.ok(done.measurement);
  assert.equal(done.measurement.source, 'manual');
  assert.ok(done.measurement.totalMs >= 0);
  assert.equal(done.measurement.withinBudget, true);
  assert.equal(done.partial.text, 'Hello there, let me explain the');
  assert.equal(done.partial.cutAtMs, 1500);
  assert.equal(c.getInterruptCount(), 1);
  assert.equal(c.getPartialTurns().length, 1);
  assert.equal(c.getBargeInStats().count, 1);
  assert.equal(c.isModelSpeaking(), false);
  assert.equal(c.takePartialTurn().text, 'Hello there, let me explain the');
  assert.equal(c.takePartialTurn(), null);
});

test('v102 barge-in v2: external partial (session server-VAD path) keeps text, no measurement', () => {
  const clock = makeClock();
  const c = new BargeInController({ clock: clock.now });
  c.modelSpeechStarted();
  c.noteModelTranscript('The answer is forty-two', false);
  clock.advance(2000);
  const p = c.takeExternalPartial('server_vad');
  assert.ok(p);
  assert.equal(p.text, 'The answer is forty-two');
  assert.equal(p.cutAtMs, 2000);
  assert.equal(p.source, 'server_vad');
  assert.equal(c.getBargeInStats().count, 0);
  assert.equal(c.isModelSpeaking(), false);
  // Final transcript ends the reply cleanly.
  c.modelSpeechStarted();
  c.noteModelTranscript('done', true);
  assert.equal(c.isModelSpeaking(), false);
});

// ---------------------------------------------------------------------------
// 3. VoiceMediaContext + describers
// ---------------------------------------------------------------------------

test('v102 media: attach validates kind, MIME, base64 and size', () => {
  const ctx = new VoiceMediaContext();
  assert.equal(ctx.attach({ kind: 'image', mimeType: 'image/svg+xml', base64: b64('x') }).ok, false);
  assert.equal(ctx.attach({ kind: 'audio', mimeType: 'audio/mp3' }).ok, false);
  assert.equal(ctx.attach({ kind: 'image', mimeType: 'image/png', base64: '!!!not-base64!!!' }).ok, false);
  const ok = ctx.attach({
    kind: 'image',
    mimeType: 'image/png',
    name: 'error.png',
    caption: 'screenshot of the error',
    base64: b64('fake-png-bytes'),
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.item.status, 'pending');
  assert.equal(ok.item.id, 'media-1');
  // Metadata-only video is allowed (no frames are uploaded).
  const video = ctx.attach({ kind: 'video', mimeType: 'video/mp4', name: 'demo.mp4', durationSec: 42 });
  assert.equal(video.ok, true);
  assert.equal(ctx.list().length, 2);
  assert.equal(ctx.remove('media-1'), true);
  assert.equal(ctx.remove('media-1'), false);
  assert.equal(ctx.getTotalBytes(), 0);
});

test('v102 media: mock describe, Q&A, and context block', async () => {
  const ctx = new VoiceMediaContext({ describer: new MockMediaDescriber() });
  assert.equal(ctx.getDescriberName(), 'mock');
  const attached = ctx.attach({
    kind: 'image',
    mimeType: 'image/jpeg',
    name: 'whiteboard.jpg',
    caption: 'whiteboard sketch of the login flow',
    base64: b64('fake-jpeg'),
  });
  assert.equal(attached.ok, true);
  assert.equal(ctx.buildMediaContextBlock().includes('not described yet'), true);
  await ctx.describe();
  const item = ctx.get('media-1');
  assert.equal(item.status, 'described');
  assert.match(item.description, /whiteboard sketch of the login flow/);
  const answer = await ctx.askAboutMedia('What is on the whiteboard?');
  assert.ok(answer);
  assert.equal(answer.itemId, 'media-1');
  assert.match(answer.answer, /What is on the whiteboard\?/);
  assert.match(answer.answer, /no vision model is configured/);
  assert.equal(answer.confidence, 'low');
  const block = ctx.buildMediaContextBlock();
  assert.match(block, /Attached media/);
  assert.match(block, /Recent media questions/);
  assert.equal(ctx.getAnswers().length, 1);
  // No media -> no answer, no block.
  const empty = new VoiceMediaContext();
  assert.equal(await empty.askAboutMedia('anything?'), null);
  assert.equal(empty.buildMediaContextBlock(), '');
});

test('v102 media: count cap prunes oldest, oversize item refused', () => {
  const ctx = new VoiceMediaContext({ maxItems: 2, maxTotalBytes: 100 });
  const big = b64('x'.repeat(200)); // ~200 bytes decoded > 100 budget
  assert.equal(ctx.attach({ kind: 'image', mimeType: 'image/png', base64: big }).ok, false);
  const small = b64('x'.repeat(10));
  assert.equal(ctx.attach({ kind: 'image', mimeType: 'image/png', base64: small }).ok, true);
  assert.equal(ctx.attach({ kind: 'image', mimeType: 'image/png', base64: small }).ok, true);
  assert.equal(ctx.attach({ kind: 'image', mimeType: 'image/png', base64: small }).ok, true);
  assert.equal(ctx.list().length, 2);
  assert.equal(ctx.list()[0].id, 'media-2'); // media-1 pruned
  assert.equal(mediaBytes(undefined), 0);
});

test('v102 media: VisionApiDescriber sends image_url, handles errors', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'A whiteboard with a login flow diagram.' } }],
      }),
    };
  };
  const d = new VisionApiDescriber({
    baseUrl: 'http://127.0.0.1:11434/v1/',
    model: 'llava',
    fetchFn: fakeFetch,
  });
  assert.equal(d.name, 'vision:llava');
  const desc = await d.describe(
    {
      id: 'media-1',
      kind: 'image',
      mimeType: 'image/png',
      base64: b64('pixels'),
      description: '',
      describedAt: 0,
      status: 'pending',
      addedAt: 1,
    },
    'What is this?',
  );
  assert.equal(desc.text, 'A whiteboard with a login flow diagram.');
  assert.equal(desc.confidence, 'high');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(calls[0].body.model, 'llava');
  const content = calls[0].body.messages[0].content;
  assert.equal(content[1].type, 'image_url');
  assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
  assert.match(content[0].text, /What is this\?/);

  // HTTP error -> throws (the context records it, never crashes).
  const failing = new VisionApiDescriber({
    baseUrl: 'http://127.0.0.1:9/v1',
    model: 'llava',
    fetchFn: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  const ctx = new VoiceMediaContext({ describer: failing });
  ctx.attach({ kind: 'image', mimeType: 'image/png', base64: b64('x') });
  await ctx.describe();
  assert.equal(ctx.get('media-1').status, 'failed');
  assert.match(ctx.get('media-1').error, /HTTP 500/);

  // Empty reply -> throws.
  const empty = new VisionApiDescriber({
    baseUrl: 'http://127.0.0.1:9/v1',
    model: 'llava',
    fetchFn: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '   ' } }] }),
    }),
  });
  await assert.rejects(() =>
    empty.describe({
      id: 'm', kind: 'image', mimeType: 'image/png', base64: b64('x'),
      description: '', describedAt: 0, status: 'pending', addedAt: 1,
    }),
  );
});

// ---------------------------------------------------------------------------
// 4. LocalVoiceStack
// ---------------------------------------------------------------------------

test('v102 local stack: mock stack transcribes, speaks, reports mock mode', async () => {
  const stack = createMockLocalVoiceStack({ script: ['hello from the local mic'] });
  const status = await stack.getStatus();
  assert.equal(status.mode, 'mock');
  assert.equal(status.stt.available, true);
  assert.equal(status.stt.id, 'mock-stt');
  assert.equal(status.tts.available, true);
  const text = await stack.transcribe(sinePcm16Frame(1600, 0.1, 440, 16_000));
  assert.equal(text, 'hello from the local mic');
  assert.equal(stack.speak('Hello world. How are you?'), 2);
  assert.equal(stack.speak('   '), 0);
  const stopped = await stack.stopSpeaking();
  assert.equal(typeof stopped.stopped, 'boolean');
  await assert.rejects(stack.transcribe(new Uint8Array([1])), /PCM16/);
});

test('v102 local stack: real engine when present, loud failure when absent', async () => {
  const stack = new LocalVoiceStack();
  const status = await stack.getStatus();
  const pcm = sinePcm16Frame(1600, 0.1, 440, 16_000);
  if (status.stt.available) {
    // Live check on this machine (whisper.cpp + tiny model are
    // installed): a sine tone transcribes to a string, never throws.
    assert.equal(status.stt.id, 'whisper-cli');
    const text = await stack.transcribe(pcm);
    assert.equal(typeof text, 'string');
  } else {
    // No engine on this machine: transcribe() fails loudly instead
    // of returning a guessed transcript.
    assert.ok(status.stt.reason);
    await assert.rejects(stack.transcribe(pcm), /whisper|local STT|unavailable/i);
  }
});

// ---------------------------------------------------------------------------
// 5. VoiceSessionV2 on a hand-driven fake transport
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

function makeV2(events, clock) {
  let transport = null;
  const v2 = new VoiceSessionV2({
    session: {
      provider: 'openai',
      transportFactory: (cb) => {
        transport = new FakeTransport(cb);
        return transport;
      },
    },
    clock: clock.now,
    longSession: { maxContextChars: 10_000 },
    onEvent: (e) => events.push(e),
  });
  return { v2, getTransport: () => transport };
}

test('v102 session v2: connect folds context into instructions, transcripts feed the long session', async () => {
  const events = [];
  const clock = makeClock();
  const { v2, getTransport } = makeV2(events, clock);
  v2.noteUserTurn('How do I fix the login bug?');
  const attached = v2.attachMedia({
    kind: 'image',
    mimeType: 'image/png',
    name: 'error.png',
    caption: 'screenshot of the error',
    base64: b64('fake-png'),
  });
  assert.equal(attached.ok, true);
  await v2.connect({ instructions: 'You are a helpful voice assistant.' });
  assert.equal(v2.getState(), 'listening');
  const instructions = v2.getSessionInstructions();
  assert.match(instructions, /helpful voice assistant/);
  assert.match(instructions, /How do I fix the login bug\?/);
  assert.match(instructions, /screenshot of the error/);
  assert.ok(events.find((e) => e.kind === 'media-attached'));

  const t = getTransport();
  t.emitAudio();
  assert.equal(v2.getState(), 'speaking');
  t.emitTranscript('Check the token refresh in auth.ts.', true);
  t.emitResponseDone();
  assert.equal(v2.getState(), 'listening');
  const turns = v2.getLongSessionTurns();
  assert.equal(turns.length, 2);
  assert.equal(turns[1].speaker, 'model');
  assert.match(turns[1].text, /token refresh/);
  assert.equal(v2.getLongSessionStats().totalTurns, 2);
  v2.disconnect();
  assert.equal(v2.getState(), 'closed');
});

test('v102 session v2: askAboutMedia records user + model turns', async () => {
  const events = [];
  const clock = makeClock();
  const { v2 } = makeV2(events, clock);
  v2.attachMedia({
    kind: 'image',
    mimeType: 'image/png',
    name: 'board.png',
    caption: 'whiteboard sketch',
    base64: b64('fake'),
  });
  const answer = await v2.askAboutMedia('What is on the whiteboard?');
  assert.ok(answer);
  assert.match(answer.answer, /whiteboard sketch/);
  assert.ok(events.find((e) => e.kind === 'media-answer'));
  const turns = v2.getLongSessionTurns();
  assert.equal(turns.length, 2);
  assert.equal(turns[0].speaker, 'user');
  assert.deepEqual(turns[0].mediaIds, ['media-1']);
  assert.equal(turns[1].speaker, 'model');
  assert.equal(await v2.askAboutMedia('   '), null); // empty question -> null
  const noMedia = new VoiceSessionV2({
    session: { provider: 'openai', transportFactory: (cb) => new FakeTransport(cb) },
  });
  assert.equal(await noMedia.askAboutMedia('What is this?'), null);
});

test('v102 session v2: manual interrupt past grace cancels and keeps the partial turn', async () => {
  const events = [];
  const clock = makeClock();
  const { v2, getTransport } = makeV2(events, clock);
  await v2.connect({});
  const t = getTransport();
  t.emitAudio(); // model starts speaking at clock 1000
  t.emitTranscript('Hello there, let me explain the login', false);
  clock.advance(200); // inside the 800ms grace window
  const early = v2.interrupt();
  assert.equal(early.action, 'ignore');
  assert.equal(early.reason, 'grace');
  assert.equal(t.cancels, 0);
  clock.advance(1000); // past grace now
  const late = v2.interrupt();
  assert.equal(late.action, 'interrupt');
  assert.equal(t.cancels, 1);
  assert.equal(v2.getState(), 'listening');
  const barge = events.find((e) => e.kind === 'barge-in-v2');
  assert.ok(barge);
  assert.equal(barge.partialText, 'Hello there, let me explain the login');
  assert.ok(barge.measurementMs !== null && barge.measurementMs >= 0);
  const turns = v2.getLongSessionTurns();
  assert.equal(turns.length, 1);
  assert.equal(turns[0].partial, true);
  assert.equal(turns[0].interrupted, true);
  assert.equal(v2.getPartialTurns().length, 1);
  assert.equal(v2.getBargeInCount(), 1);
  v2.disconnect();
});

test('v102 session v2: server-VAD interrupt keeps the partial without a v2 measurement', async () => {
  const events = [];
  const clock = makeClock();
  const { v2, getTransport } = makeV2(events, clock);
  await v2.connect({});
  const t = getTransport();
  t.emitAudio();
  t.emitTranscript('The answer is forty-two, and', false);
  clock.advance(2000);
  t.emitSpeechStarted(); // session's own server-VAD barge-in
  assert.equal(t.cancels, 1);
  const barge = events.find((e) => e.kind === 'barge-in-v2');
  assert.ok(barge);
  assert.equal(barge.partialText, 'The answer is forty-two, and');
  assert.equal(barge.measurementMs, null);
  assert.equal(v2.getLongSessionTurns()[0].partial, true);
  v2.disconnect();
});

test('v102 session v2: summary events surface, snapshot round-trips', async () => {
  const events = [];
  const clock = makeClock();
  const { v2 } = makeV2(events, clock);
  // Tiny budget via a second session: drive compaction through turns.
  const small = new VoiceSessionV2({
    session: { provider: 'openai', transportFactory: (cb) => new FakeTransport(cb) },
    longSession: { maxContextChars: 100, keepRecentTurns: 1 },
    onEvent: (e) => events.push(e),
  });
  for (let i = 0; i < 5; i++) {
    small.noteUserTurn(`Spoken question number ${i} about the login flow?`);
  }
  assert.ok(small.getLongSessionStats().compactions >= 1);
  assert.ok(events.find((e) => e.kind === 'summary'));
  const snap = small.snapshotLongSession();
  assert.equal(v2.restoreLongSession(snap), true);
  assert.equal(v2.getLongSessionStats().totalTurns, small.getLongSessionStats().totalTurns);
  v2.disconnect();
  small.disconnect();
});

// ---------------------------------------------------------------------------
// 6. UI: v2 panel section + i18n parity (source-level, no Electron)
// ---------------------------------------------------------------------------

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const V2_KEYS = [
  'voice.v2.title',
  'voice.v2.longSession',
  'voice.v2.mediaTitle',
  'voice.v2.mediaEmpty',
  'voice.v2.mediaPending',
  'voice.v2.mediaDescribed',
  'voice.v2.mediaFailed',
  'voice.v2.bargeInIgnored',
];

test('v102 ui: v2 keys exist in all 6 locales with matching placeholders', () => {
  const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  const dicts = {};
  for (const code of ['vi', 'en', 'zh', 'ja', 'es', 'fr']) {
    dicts[code] = JSON.parse(read(`apps/desktop/src/renderer/i18n/locales/${code}.json`));
  }
  for (const key of V2_KEYS) {
    for (const code of ['vi', 'zh', 'ja', 'es', 'fr']) {
      assert.ok(dicts[code][key], `${code} is missing ${key}`);
      assert.ok(dicts[code][key].trim().length > 0, `${code} has an empty ${key}`);
      assert.deepEqual(placeholders(dicts[code][key]), placeholders(dicts.en[key]), `${key} placeholders differ in ${code}`);
    }
  }
});

test('v102 ui: RealtimeVoicePanel renders the v2 section from optional props', () => {
  const src = read('apps/desktop/src/renderer/components/RealtimeVoicePanel.tsx');
  for (const testid of [
    'realtime-v2',
    'realtime-v2-long-session',
    'realtime-v2-media',
    'realtime-v2-bargein',
  ]) {
    assert.ok(src.includes(`data-testid="${testid}"`), `panel is missing ${testid}`);
  }
  for (const key of V2_KEYS) {
    assert.ok(src.includes(`t('${key}'`), `panel never uses ${key}`);
  }
  // v2 props are optional — the section only renders when v2 data exists.
  assert.match(src, /longSessionStats\?:/);
  assert.match(src, /mediaItems\?:/);
  assert.match(src, /bargeInV2Ignored\?:/);
});
