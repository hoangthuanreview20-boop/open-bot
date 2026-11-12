/**
 * Harness entry for tests/tts-voice-v082-renderer.test.mjs.
 *
 * Bundled with esbuild and mounted in a bare Electron window — no
 * main process, no preload. `__mountTts(scenario)` mounts the real
 * `ChatView` with one user message and one assistant message, and a
 * mocked `window.openBot` whose `speakText` either speaks (scenario
 * `ok`) or honestly reports no engine (scenario `no-engine`):
 *
 * Scenarios:
 *   ok         TTS available: getTtsStatus reports available, the
 *              voice list has vi/vi-vn-x-south/en; the test picks a
 *              voice + rate, clicks the speaker button and checks
 *              speakText got the text AND the chosen opts.
 *   no-engine  getTtsStatus reports unavailable; the voice/rate
 *              controls must stay hidden (speak still reports the
 *              honest no-engine result).
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
  const calls: Array<{ text: string; lang?: string; opts?: { voice?: string; rate?: number } }> = [];
  (window as unknown as { __speakCalls: Array<{ text: string; lang?: string; opts?: { voice?: string; rate?: number } }> }).__speakCalls = calls;
  const noopUnsub = () => () => undefined;
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
      Promise.resolve([
        { id: 'vi', name: 'Vietnamese (Northern)', lang: 'vi' },
        { id: 'vi-vn-x-south', name: 'Vietnamese (Southern)', lang: 'vi' },
        { id: 'en', name: 'English (Great Britain)', lang: 'en' },
      ]),
    speakText: (text: string, lang?: string, opts?: { voice?: string; rate?: number }) => {
      calls.push({ text, lang, opts });
      if (scenario === 'no-engine') {
        return Promise.resolve({ spoken: false, engineId: null, reason: 'no-engine-available' });
      }
      return Promise.resolve({ spoken: true, engineId: 'mock' });
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

(window as unknown as { __mountTtsV082: (s: string) => boolean }).__mountTtsV082 = mountTts;
