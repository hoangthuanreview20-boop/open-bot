/**
 * Harness entry for tests/tts-v081-renderer.test.mjs.
 *
 * Bundled with esbuild and mounted in a bare Electron window — no
 * main process, no preload. `__mountTts(scenario)` mounts the real
 * `ChatView` with one user message and one assistant message, and a
 * mocked `window.openBot` whose `speakText` either speaks (scenario
 * `ok`) or honestly reports no engine (scenario `no-engine`):
 *
 * Scenarios:
 *   ok         speakText resolves { spoken: true }; the test clicks
 *              the speaker button and checks it was called with the
 *              answer text and no notice appears.
 *   no-engine  speakText resolves { spoken: false, reason:
 *              'no-engine-available' }; the test clicks the button
 *              and checks the honest "no engine" notice appears.
 *
 * v0.83: the mock also answers `getTtsStatus` (available unless
 * `no-engine`) and `listTtsVoices`, because ChatView now probes the
 * status at click time before choosing the system engine vs the
 * browser fallback — a mock without the status API would leave the
 * view unable to know an engine exists at all.
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

function installMock(scenario: string): void {
  const calls: Array<{ text: string }> = [];
  (window as unknown as { __speakCalls: Array<{ text: string }> }).__speakCalls = calls;
  const noopUnsub = () => () => undefined;
  if (scenario === 'no-engine') {
    // Deterministic "no browser voices either": headless Electron's
    // real speechSynthesis may or may not list voices, so the
    // no-engine notice must not depend on it.
    Object.defineProperty(window, 'speechSynthesis', {
      value: {
        speaking: false,
        pending: false,
        getVoices: () => [],
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        onvoiceschanged: null,
        speak: () => undefined,
        cancel: () => undefined,
      },
      configurable: true,
    });
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
        scenario === 'no-engine'
          ? { available: false, engineId: null, engines: [] }
          : {
              available: true,
              engineId: 'espeak-ng',
              engines: [{ id: 'espeak-ng', name: 'eSpeak NG', kind: 'system', available: true }],
            },
      ),
    listTtsVoices: () =>
      Promise.resolve([{ id: 'vi', name: 'Vietnamese (Northern)', lang: 'vi' }]),
    speakText: (text: string) => {
      calls.push({ text });
      if (scenario === 'no-engine') {
        return Promise.resolve({ spoken: false, engineId: null, reason: 'no-engine-available' });
      }
      return Promise.resolve({ spoken: true, engineId: 'mock' });
    },
    stopTts: () => Promise.resolve({ stopped: false, engineId: null }),
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

(window as unknown as { __mountTts: (s: string) => boolean }).__mountTts = mountTts;
