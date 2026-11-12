/**
 * Harness entry for tests/tts-stop-v083-renderer.test.mjs.
 *
 * Bundled with esbuild and mounted in a bare Electron window — no
 * main process, no preload. `__mountTtsV083(scenario)` mounts the real
 * `ChatView` with one user message and one assistant message, and a
 * mocked `window.openBot` plus (for the browser scenarios) a fake
 * `window.speechSynthesis`:
 *
 * Scenarios:
 *   slow     System TTS available, but `speakText` never resolves on
 *            its own (a long utterance): clicking the speaker button
 *            shows "⏹ Dừng"; clicking it again calls `stopTts`, which
 *            resolves the pending speak with
 *            `{ spoken: false, reason: 'stopped' }` (like the real
 *            main process), and the button goes back to "🔊 Nghe".
 *   browser  No system engine, but Chromium has voices (fake
 *            `speechSynthesis` with vi + en): the voice/rate picker
 *            appears with the browser voices and the
 *            "giọng trình duyệt" hint; clicking the speaker button
 *            speaks through the fake (recorded in
 *            `window.__browserCalls`); the stop button cancels it
 *            (`cancel` recorded, utterance gets `onerror` 'canceled').
 *   browser-late  No system engine and no browser voices YET: the
 *            picker is hidden until the test fires
 *            `window.__fireBrowserVoices()` (voices arrive +
 *            `voiceschanged`), then the picker appears.
 *   none     No system engine and no browser voices at all: no picker,
 *            clicking the speaker button shows the honest no-engine
 *            notice.
 *
 * The mock data holds no secret and no real account. The view reads
 * the real vi.json through useT (default locale is vi), so assertions
 * check the real Vietnamese strings.
 */
import { createRoot, type Root } from 'react-dom/client';
import ChatView, { type ChatMessageWithVision } from '../../apps/desktop/src/renderer/components/ChatView';
import type { BotConfigLike } from '../../apps/desktop/src/renderer/types';

let root: Root | null = null;

const BOT: BotConfigLike = {
  id: 'bot-a',
  name: 'Bot A',
  providerId: 'ollama',
  model: 'llama3',
  systemPrompt: '',
  workspaceDir: '/tmp',
  autoApprove: false,
};

const MESSAGES: ChatMessageWithVision[] = [
  { id: 'm1', role: 'user', text: 'Xin chào', createdAt: 1 },
  { id: 'm2', role: 'assistant', text: 'Xin chào, đây là câu trả lời.', createdAt: 2 },
];

const BROWSER_VOICES = [
  { name: 'Google Tiếng Việt', lang: 'vi-VN', voiceURI: 'Google Tiếng Việt' },
  { name: 'Google US English', lang: 'en-US', voiceURI: 'Google US English' },
];

type AnyRecord = Record<string, unknown>;

function installFakeSpeech(scenario: string): void {
  const w = window as unknown as AnyRecord;
  const calls: Array<{ text: string; voice?: string; rate?: number }> = [];
  const cancels: Array<{ at: number }> = [];
  w.__browserCalls = calls;
  w.__browserCancels = cancels;
  let voices: Array<{ name: string; lang: string; voiceURI: string }> =
    scenario === 'browser' ? [...BROWSER_VOICES] : [];
  let speaking = false;
  let pending = false;
  let currentUtter: AnyRecord | null = null;
  const listeners = new Set<() => void>();
  const fake = {
    get speaking() {
      return speaking;
    },
    get pending() {
      return pending;
    },
    getVoices: () => [...voices],
    addEventListener: (_type: string, cb: () => void) => {
      listeners.add(cb);
    },
    removeEventListener: (_type: string, cb: () => void) => {
      listeners.delete(cb);
    },
    onvoiceschanged: null as (() => void) | null,
    speak: (utter: AnyRecord) => {
      currentUtter = utter;
      speaking = true;
      pending = false;
      calls.push({
        text: String(utter.text ?? ''),
        voice: (utter.voice as { voiceURI?: string; name?: string } | null)?.voiceURI ??
          (utter.voice as { name?: string } | null)?.name,
        rate: typeof utter.rate === 'number' ? utter.rate : undefined,
      });
      // Stays speaking until cancel() — like a long utterance.
    },
    cancel: () => {
      cancels.push({ at: Date.now() });
      const wasSpeaking = speaking || pending;
      speaking = false;
      pending = false;
      // Chromium fires onerror 'canceled' on the utterance.
      if (wasSpeaking && currentUtter && typeof currentUtter.onerror === 'function') {
        (currentUtter.onerror as (ev: { error: string }) => void)({ error: 'canceled' });
      }
      currentUtter = null;
    },
  };
  // Shadow the native getter on Window.prototype with an own property.
  Object.defineProperty(window, 'speechSynthesis', { value: fake, configurable: true });
  (w as AnyRecord).__fireBrowserVoices = () => {
    voices = [...BROWSER_VOICES];
    for (const cb of [...listeners]) cb();
    if (typeof fake.onvoiceschanged === 'function') fake.onvoiceschanged();
    return true;
  };
}

function installMock(scenario: string): void {
  const calls: Array<{ text: string; lang?: string; opts?: { voice?: string; rate?: number } }> = [];
  (window as unknown as { __speakCalls: typeof calls }).__speakCalls = calls;
  const stopCalls: Array<{ at: number }> = [];
  (window as unknown as { __stopCalls: typeof stopCalls }).__stopCalls = stopCalls;
  // Pending speakText promise for the `slow` scenario: resolved by stopTts.
  let releaseSpeak: ((res: { spoken: boolean; engineId: string | null; reason?: string }) => void) | null = null;
  (window as unknown as { __releaseSpeak: () => boolean }).__releaseSpeak = () => {
    if (!releaseSpeak) return false;
    releaseSpeak({ spoken: false, engineId: 'espeak-ng', reason: 'stopped' });
    releaseSpeak = null;
    return true;
  };
  const noopUnsub = () => () => undefined;
  const systemAvailable = scenario === 'slow';
  if (scenario === 'browser' || scenario === 'browser-late' || scenario === 'none') {
    installFakeSpeech(scenario);
  }
  const api: Record<string, unknown> = {
    voiceAvailable: () => Promise.resolve({ available: false }),
    onVoiceTranscript: noopUnsub,
    onVoiceAudio: noopUnsub,
    onVoiceError: noopUnsub,
    onVoiceToolCall: noopUnsub,
    voiceDisconnect: () => Promise.resolve({ ok: true }),
    getTtsStatus: () =>
      Promise.resolve(
        systemAvailable
          ? {
              available: true,
              engineId: 'espeak-ng',
              engines: [{ id: 'espeak-ng', name: 'eSpeak NG', kind: 'system', available: true }],
            }
          : { available: false, engineId: null, engines: [] },
      ),
    listTtsVoices: () =>
      Promise.resolve([
        { id: 'vi', name: 'Vietnamese (Northern)', lang: 'vi' },
        { id: 'vi-vn-x-south', name: 'Vietnamese (Southern)', lang: 'vi' },
        { id: 'en', name: 'English (Great Britain)', lang: 'en' },
      ]),
    speakText: (text: string, lang?: string, opts?: { voice?: string; rate?: number }) => {
      calls.push({ text, lang, opts });
      if (scenario === 'slow') {
        // Never resolves on its own — only stopTts releases it.
        return new Promise((resolve) => {
          releaseSpeak = resolve as (res: { spoken: boolean; engineId: string | null; reason?: string }) => void;
        });
      }
      return Promise.resolve({ spoken: true, engineId: 'mock' });
    },
    stopTts: () => {
      stopCalls.push({ at: Date.now() });
      (window as unknown as { __releaseSpeak: () => boolean }).__releaseSpeak();
      return Promise.resolve({ stopped: stopCalls.length > 0, engineId: 'espeak-ng' });
    },
  };
  (window as unknown as { openBot: unknown }).openBot = api;
}

function mountTts(scenario: string): boolean {
  installMock(scenario);
  const el = document.getElementById('root');
  if (!el) return false;
  if (root) {
    root.unmount();
    root = null;
  }
  root = createRoot(el);
  root.render(
    <ChatView bot={BOT} messages={MESSAGES} status="idle" toolEvents={[]} onSend={() => undefined} />,
  );
  return true;
}

(window as unknown as { __mountTtsV083: (s: string) => boolean }).__mountTtsV083 = mountTts;
