/**
 * Tests for v0.95 Đội D3 — realtime voice UI + IPC wiring
 * (source-level, no Electron run):
 *
 *   1. `requireWsUrl` (packages/core/src/ipc/validate.ts): accepts
 *      ws(s) realtime URLs, rejects http(s) and garbage.
 *   2. i18n: all 6 locales carry the 40 `voice.realtime.*` keys
 *      (24 in v0.95 + 14 `voice.realtime.live.*` keys added by the
 *      v0.96 live-voice work + 2 barge-in stats keys added by the
 *      v0.98 live-voice work), with identical key sets (parity 6/6).
 *   3. RealtimeVoicePanel: start/stop/interrupt/hold-to-talk
 *      controls + provider + turn-mode selects (data-testids).
 *   4. Preload exposes the realtime IPCs; main registers the
 *      realtime IPC channels.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/realtime-ui-v095d3.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { requireWsUrl } from '../packages/core/dist/ipc/validate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const LOCALES = ['vi', 'en', 'zh', 'ja', 'es', 'fr'];
const REALTIME_KEYS = [
  'voice.realtime.title',
  'voice.realtime.provider',
  'voice.realtime.providerOpenai',
  'voice.realtime.providerGemini',
  'voice.realtime.providerOpenaiCompatible',
  'voice.realtime.turnMode',
  'voice.realtime.turnServerVad',
  'voice.realtime.turnLocalVad',
  'voice.realtime.turnPushToTalk',
  'voice.realtime.start',
  'voice.realtime.stop',
  'voice.realtime.interrupt',
  'voice.realtime.holdToTalk',
  'voice.realtime.talking',
  'voice.realtime.stateIdle',
  'voice.realtime.stateConnecting',
  'voice.realtime.stateListening',
  'voice.realtime.stateSpeaking',
  'voice.realtime.stateInterrupted',
  'voice.realtime.stateReconnecting',
  'voice.realtime.stateClosed',
  'voice.realtime.bargeIns',
  'voice.realtime.notAvailable',
  'voice.realtime.hint',
  'voice.realtime.live.adapterStatus',
  'voice.realtime.live.healthDegraded',
  'voice.realtime.live.healthDown',
  'voice.realtime.live.healthHealthy',
  'voice.realtime.live.healthUnknown',
  'voice.realtime.live.keyConfigured',
  'voice.realtime.live.keyMissing',
  'voice.realtime.live.latency',
  'voice.realtime.live.latencyUnknown',
  'voice.realtime.live.mockMode',
  'voice.realtime.live.bargeInStats',
  'voice.realtime.live.bargeInBreaches',
  'voice.realtime.live.sessionResumed',
  'voice.realtime.live.transcriptEmpty',
  'voice.realtime.live.transcriptInterim',
  'voice.realtime.live.transcriptTitle',
];

test('realtime-ui: requireWsUrl accepts ws/wss realtime URLs', () => {
  assert.equal(
    requireWsUrl('wss://api.openai.com/v1/realtime?model=x', 'realtimeUrl'),
    'wss://api.openai.com/v1/realtime?model=x',
  );
  assert.equal(
    requireWsUrl(
      'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=k',
      'realtimeUrl',
    ).startsWith('wss://generativelanguage.googleapis.com/ws/'),
    true,
  );
  assert.equal(requireWsUrl('ws://127.0.0.1:8765/realtime', 'realtimeUrl'), 'ws://127.0.0.1:8765/realtime');
  assert.throws(() => requireWsUrl('https://api.openai.com/v1/realtime', 'realtimeUrl'), /ws:\/\/ hoặc wss:\/\//);
  assert.throws(() => requireWsUrl('not-a-url', 'realtimeUrl'), /không phải URL/);
  assert.throws(() => requireWsUrl('', 'realtimeUrl'), /không rỗng|chuỗi/);
});

test('realtime-ui: all 6 locales carry the 40 voice.realtime.* keys (parity 6/6)', () => {
  const keySets = [];
  for (const loc of LOCALES) {
    const data = JSON.parse(read(`apps/desktop/src/renderer/i18n/locales/${loc}.json`));
    for (const key of REALTIME_KEYS) {
      assert.ok(
        typeof data[key] === 'string' && data[key].length > 0,
        `${loc} is missing ${key}`,
      );
    }
    keySets.push(new Set(Object.keys(data).filter((k) => k.startsWith('voice.realtime.'))));
  }
  for (let i = 1; i < keySets.length; i++) {
    assert.deepEqual([...keySets[i]].sort(), [...keySets[0]].sort());
  }
  assert.equal(keySets[0].size, 40);
});

test('realtime-ui: RealtimeVoicePanel renders provider/turn-mode/start/stop/interrupt/talk controls', () => {
  const src = read('apps/desktop/src/renderer/components/RealtimeVoicePanel.tsx');
  for (const id of [
    'realtime-voice-panel',
    'realtime-state',
    'realtime-provider',
    'realtime-turn-mode',
    'realtime-start',
    'realtime-stop',
    'realtime-interrupt',
    'realtime-talk',
    'realtime-bargeins',
  ]) {
    assert.ok(src.includes(`data-testid="${id}"`), `panel is missing ${id}`);
  }
  for (const key of ['voice.realtime.title', 'voice.realtime.turnServerVad', 'voice.realtime.turnLocalVad', 'voice.realtime.turnPushToTalk']) {
    assert.ok(src.includes(`t('${key}')`), `panel does not use ${key}`);
  }
});

test('realtime-ui: preload exposes realtime IPCs and main registers them', () => {
  const preload = read('apps/desktop/src/main/preload.ts');
  for (const name of [
    'voiceRealtimeConnect',
    'voiceRealtimeDisconnect',
    'voiceRealtimeMode',
    'voiceRealtimeTalk',
    'voiceRealtimeInterrupt',
    'voiceRealtimeSendAudio',
    'onVoiceRealtimeState',
  ]) {
    assert.ok(preload.includes(name), `preload is missing ${name}`);
  }
  assert.ok(preload.includes("'voice:realtime-state'"), 'preload missing voice:realtime-state channel');
  const main = read('apps/desktop/src/main/main.ts');
  for (const channel of [
    'voice:realtime-connect',
    'voice:realtime-disconnect',
    'voice:realtime-mode',
    'voice:realtime-talk',
    'voice:realtime-interrupt',
    'voice:realtime-audio',
  ]) {
    assert.ok(main.includes(`'${channel}'`), `main is missing ${channel}`);
  }
  assert.ok(main.includes('new RealtimeSession('), 'main does not create a RealtimeSession');
  assert.ok(main.includes('requireWsUrl(p.realtimeUrl'), 'main still validates realtimeUrl as http(s)');
});

test('realtime-ui: ChatView renders the realtime panel and routes mic frames per path', () => {
  const src = read('apps/desktop/src/renderer/components/ChatView.tsx');
  assert.ok(src.includes('<RealtimeVoicePanel'), 'ChatView does not render RealtimeVoicePanel');
  assert.ok(src.includes('voiceRealtimeSendAudio'), 'ChatView does not route mic frames to the realtime session');
  assert.ok(src.includes('startRealtime'), 'ChatView has no startRealtime path');
  assert.ok(src.includes('onVoiceRealtimeState'), 'ChatView does not subscribe to realtime state');
});
