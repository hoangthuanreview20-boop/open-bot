import { useEffect, useRef, useState } from 'react';
import type { BotConfigLike, ChatMessageView, ToolCallView } from '../types';
import { useT } from '../i18n/useT';
import { composerDraftsStore } from '../store/persistedStore';
import workletUrl from '../pcm-capture.worklet.js?url';
import CallView from './CallView';
import type { VoiceSurfaceOption } from './CallView';
import type { CallStatus } from './CallView';
import RealtimeVoicePanel, { type RealtimeAdapterHealth } from './RealtimeVoicePanel';
import type {
  RealtimePanelState,
  RealtimeProviderOption,
  RealtimeTurnModeOption,
} from './RealtimeVoicePanel';
import { appendCallTranscript, concatPcm16Base64, insertDictationText } from '../voice/voiceUi';
import type { CallTranscriptLine } from '../voice/voiceUi';
// v0.83: browser `speechSynthesis` fallback when the machine has no
// system TTS engine (see `../voice/ttsBrowser.ts`).
import {
  hasBrowserVoices,
  listBrowserVoices,
  onBrowserVoicesChanged,
  speakWithBrowser,
  stopBrowserSpeech,
  type BrowserTtsVoice,
} from '../voice/ttsBrowser';
import Markdown from './Markdown';
import ComposerAutocomplete from './ComposerAutocomplete';
import {
  ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_MAX_ITEMS,
  VISION_MAX_IMAGE_BYTES,
  VISION_MAX_IMAGES,
  VISION_MAX_TOTAL_BYTES,
  applyCompletion,
  buildAttachmentBlocks,
  buildSendText,
  buildVisionAttachments,
  classifyAttachment,
  detectTrigger,
  formatFileSize,
  mentionItems,
  relativeWorkspacePath,
  slashItems,
  truncateTextContent,
  validateVisionItems,
  visionMimeTypeForFile,
  wouldExceedTotal,
  type AttachmentSendItem,
  type AutocompleteItem,
  type ComposerTrigger,
  type VisionAttachment,
  type VisionValidationResult,
} from './composer';
import { formatTokenCount, formatTurnCostUsd } from './turnUsage';
import { botColor, botInitial } from './botColors';

export type ChatStatus = 'idle' | 'thinking' | 'tool';

export interface ToolEvent {
  id: string;
  call: ToolCallView;
  result?: unknown;
  done: boolean;
  /** v0.59 (UI-2): the run was stopped while this call was still open. */
  stopped?: boolean;
}

/**
 * v0.63 (vision channel): one chat message as shown in the UI, plus the
 * images attached to it (renderer mirror of core `VisionAttachment` —
 * see composer.ts). The optimistic user bubble carries the full base64
 * so the thumbnails render immediately; v0.65: history reloads re-read
 * the stored images (files under `.open-bot/attachments/`), so
 * reloaded bubbles show thumbnails too — a stored image whose file is
 * gone/corrupt arrives with `unavailable: true` and renders as a
 * placeholder. Only pre-v0.65 messages have no `attachments` and show
 * the old metadata line in the text instead.
 * v0.65: `attachments` now also lives on `ChatMessageView`
 * (renderer/types.ts); this alias is kept so the optimistic-send
 * shape stays explicit at the call site.
 */
export type ChatMessageWithVision = ChatMessageView & {
  attachments?: VisionAttachment[];
};

interface Props {
  bot: BotConfigLike | null;
  messages: ChatMessageWithVision[];
  status: ChatStatus;
  toolEvents: ToolEvent[];
  /**
   * v0.63: send the message text plus the vision images (if any).
   * `text` may be empty when images are present (image-only message).
   */
  onSend: (text: string, visionAttachments?: VisionAttachment[]) => void;
  /** v0.59 (UI-2): stop the current run (App calls IPC `chat:stop`). */
  onStop?: () => void;
  onVoiceError?: (message: string) => void;
  /** Source line for the running model (account label or "API key (Vault)") — never a secret. */
  sourceLabel?: string | null;
  /** Open the model picker (switch mid-chat, thread kept). */
  onSwitchModel?: () => void;
  /**
   * v0.62 (UI-13): text the command palette asks the composer to insert
   * (a picked slash command). `nonce` dedupes: each insert applies once,
   * even across re-renders. Appended to whatever the user already typed.
   */
  externalInsert?: { text: string; nonce: number } | null;
}

/** Chunked ArrayBuffer -> base64 (avoids spreading huge arrays into btoa). */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Screen the user is looking at during a voice call (P0-1 surface
 *  register). The spoken reply is shaped for this surface: a desk user
 *  sees the transcript/diff, a CarPlay user sees nothing. The type
 *  lives in CallView (v0.59), which renders the surface select. */
export type { VoiceSurfaceOption } from './CallView';

/**
 * Play a short two-note earcon with WebAudio (P0-1 chime): a rising
 * pair when a call connects, a falling pair when it ends. Frequencies
 * mirror VOICE_CALL_CHIME_NOTES in @open-bot/core/voice — short audio
 * cues stand in for repetitive verbal receipts while on a call.
 */
function playEarcon(kind: 'connect' | 'disconnect'): void {
  try {
    const ctx = new AudioContext();
    const notes = kind === 'connect' ? [880, 1174.66] : [659.25, 440];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = ctx.currentTime + i * 0.12;
      gain.gain.setValueAtTime(0.12, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.2);
    });
    setTimeout(() => void ctx.close().catch(() => undefined), 600);
  } catch {
    // Audio unavailable (headless smoke test, no device) — the call
    // works without the chime.
  }
}

export default function ChatView({ bot, messages, status, toolEvents, onSend, onStop, onVoiceError, sourceLabel, onSwitchModel, externalInsert }: Props) {
  const t = useT();
  const [input, setInput] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  // v0.62 (UI-13): nonce of the last palette insert already applied —
  // the effect below runs on every externalInsert change, including
  // re-renders with the same object.
  const appliedInsertNonceRef = useRef<number | null>(null);
  // v0.60 (UI-6): slash commands of the current bot, from the registry
  // via the optional `window.openBot.listSlashCommands` (main exposes
  // `slash:list` in a follow-up; missing method = no commands, the
  // popup shows the "no commands yet" hint instead of a hardcoded list).
  const [slashCommands, setSlashCommands] = useState<Array<{ name: string; description: string }>>([]);
  useEffect(() => {
    if (!bot) return;
    let alive = true;
    const api = window.openBot as unknown as {
      listSlashCommands?: (botId: string) => Promise<Array<{ name: string; description: string }>>;
    };
    if (typeof api.listSlashCommands !== 'function') {
      setSlashCommands([]);
      return;
    }
    void api
      .listSlashCommands(bot.id)
      .then((list) => {
        if (alive) setSlashCommands(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (alive) setSlashCommands([]);
      });
    return () => {
      alive = false;
    };
  }, [bot?.id]);
  // v0.60 (UI-6): live autocomplete trigger + popup rows + active row.
  const [autocomplete, setAutocomplete] = useState<{
    trigger: ComposerTrigger;
    items: AutocompleteItem[];
    activeIndex: number;
  } | null>(null);
  // v0.60 (UI-7): files attached to the next message (chips above the
  // textarea). Content is read here only for outside-workspace text
  // files; in-workspace files travel as `@files <rel-path>` and the
  // coordinator reads them (see composer.ts).
  const [attachments, setAttachments] = useState<AttachmentSendItem[]>([]);
  const [attachNotice, setAttachNotice] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // v0.63 (vision channel): image the user clicked to view large
  // (data URL built from the bubble's own base64 — never logged).
  const [previewImage, setPreviewImage] = useState<{ src: string; name: string } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // v0.59 (UI-2): Stop was pressed while a run is in flight. The button
  // stays disabled until the run settles and status returns to idle.
  const [stopping, setStopping] = useState(false);
  // v0.81: TTS (local-first) — read one assistant answer aloud.
  // `speakingId` is the message currently being spoken; `ttsNotice`
  // explains a failure honestly (e.g. no engine on this machine).
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [ttsNotice, setTtsNotice] = useState<string | null>(null);
  // v0.83: which voice actually speaks — 'system' (main's engine)
  // or 'browser' (`speechSynthesis` fallback). Kept as a ref only
  // (v0.84c removed the state: nothing renders from it — the hint is
  // conditioned on `ttsAvailable`/`browserVoices` — and `stopSpeaking`
  // must read the value synchronously, not after a re-render).
  // v0.83: browser voices (only used when there is no system
  // engine). `speakSeq` invalidates a stale `speakMessage` promise
  // after Stop, so its `finally` cannot clear a newer utterance.
  const [browserVoices, setBrowserVoices] = useState<BrowserTtsVoice[]>([]);
  const speakSeqRef = useRef(0);
  // v0.84c: which backend is speaking right now ('system' | 'browser').
  // `stopSpeaking` must decide from the value at click time — React
  // state would be stale until the next render, so a stop clicked in
  // the gap between starting the browser utterance and the re-render
  // would read `null`, call main's `stopTts()` (nothing to stop) and
  // leave the browser utterance speaking with the button already
  // reset to "Listen". A ref is written synchronously wherever the
  // source changes below, so the stop always hits the right backend.
  const ttsSourceRef = useRef<'system' | 'browser' | null>(null);
  // v0.82: TTS voice/rate selection — only shown when the machine
  // really has a TTS engine; choices persist in localStorage.
  const [ttsAvailable, setTtsAvailable] = useState(false);
  const [ttsVoices, setTtsVoices] = useState<Array<{ id: string; name: string; lang: string }>>([]);
  const [ttsVoice, setTtsVoice] = useState<string>(() => {
    try {
      return window.localStorage.getItem('open-bot:tts-voice') ?? '';
    } catch {
      return '';
    }
  });
  const [ttsRate, setTtsRate] = useState<number>(() => {
    try {
      const raw = Number(window.localStorage.getItem('open-bot:tts-rate'));
      return [0.75, 1, 1.25, 1.5].includes(raw) ? raw : 1;
    } catch {
      return 1;
    }
  });
  useEffect(() => {
    let alive = true;
    let unsubBrowser: (() => void) | null = null;
    const api = window.openBot;
    if (typeof api?.getTtsStatus !== 'function') return;
    void api
      .getTtsStatus()
      .then((status) => {
        if (!alive) return;
        if (!status?.available) {
          // v0.83: no system engine — fall back to the browser's own
          // voices when Chromium has any (loaded async: re-check on
          // `voiceschanged`). Only then does the voice/rate picker
          // appear; an empty list keeps the honest no-engine notice.
          if (hasBrowserVoices()) setBrowserVoices(listBrowserVoices());
          unsubBrowser = onBrowserVoicesChanged(() => {
            if (alive && hasBrowserVoices()) setBrowserVoices(listBrowserVoices());
          });
          return;
        }
        setTtsAvailable(true);
        if (typeof api.listTtsVoices !== 'function') return;
        return api
          .listTtsVoices()
          .then((voices) => {
            if (alive && Array.isArray(voices)) setTtsVoices(voices);
          })
          .catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      unsubBrowser?.();
    };
  }, []);

  /** Read one assistant answer aloud via main's TTS harness. */
  const speakMessage = async (id: string, text: string) => {
    const seq = ++speakSeqRef.current;
    setSpeakingId(id);
    setTtsNotice(null);
    try {
      // Re-probe at click time (v0.83 fix): the mount-time probe may
      // not have resolved yet when the user clicks fast — speaking
      // must not depend on a stale `ttsAvailable` flag, or a fast
      // click would wrongly report "no engine".
      let useSystem = ttsAvailable;
      if (!useSystem && typeof window.openBot?.getTtsStatus === 'function') {
        try {
          const status = await window.openBot.getTtsStatus();
          useSystem = status?.available === true;
          if (useSystem) setTtsAvailable(true);
        } catch {
          useSystem = false;
        }
      }
      if (seq !== speakSeqRef.current) return;
      if (useSystem) {
        if (typeof window.openBot?.speakText !== 'function') return;
        ttsSourceRef.current = 'system';
        const res = await window.openBot.speakText(text, undefined, {
          voice: ttsVoice || undefined,
          rate: ttsRate,
        });
        if (seq !== speakSeqRef.current) return;
        if (!res.spoken) {
          setTtsNotice(
            res.reason === 'no-engine-available' ? t('chat.ttsNoEngine') : t('chat.ttsFailed'),
          );
        }
      } else {
        // Browser fallback: re-check the live voice list too — voices
        // may have arrived after the last `voiceschanged` handling.
        let voices = browserVoices;
        if (voices.length === 0) {
          voices = listBrowserVoices();
          if (voices.length > 0) setBrowserVoices(voices);
        }
        if (voices.length > 0) {
          // v0.83: browser fallback — only when Chromium really has
          // voices; the source is shown, never hidden.
          ttsSourceRef.current = 'browser';
          const res = await speakWithBrowser(text, { voice: ttsVoice || undefined, rate: ttsRate });
          if (seq !== speakSeqRef.current) return;
          if (!res.spoken) {
            setTtsNotice(
              res.reason === 'no-browser-voices' ? t('chat.ttsNoEngine') : t('chat.ttsBrowserFailed'),
            );
          }
        } else {
          setTtsNotice(t('chat.ttsNoEngine'));
        }
      }
    } catch {
      if (seq !== speakSeqRef.current) return;
      setTtsNotice(t('chat.ttsFailed'));
    } finally {
      if (seq === speakSeqRef.current) {
        setSpeakingId(null);
        ttsSourceRef.current = null;
      }
    }
  };

  /**
   * v0.83: stop the utterance that is still speaking — kill the
   * system engine process via main (`tts:stop`) or cancel the
   * browser utterance. Invalidates the in-flight `speakMessage`
   * first so its `finally` cannot clear a newer utterance, and
   * resets the UI state immediately (best-effort: a failing stop
   * never leaves the button stuck on "reading").
   */
  const stopSpeaking = async () => {
    speakSeqRef.current++;
    setSpeakingId(null);
    // v0.84c: read the ref, not the state — the state may still hold
    // the pre-speak value if the stop lands before the re-render.
    const source = ttsSourceRef.current;
    ttsSourceRef.current = null;
    try {
      if (source === 'browser') {
        stopBrowserSpeech();
      } else if (typeof window.openBot?.stopTts === 'function') {
        await window.openBot.stopTts();
      }
    } catch {
      // Stop is best-effort — the UI state is already reset above.
    }
  };
  useEffect(() => {
    if (status === 'idle') setStopping(false);
  }, [status]);
  // v0.54 (P1-10): draft id of the composer for the current bot (UUID key,
  // stored in the persisted store `open-bot:composer-drafts`).
  const draftIdRef = useRef<string | null>(null);

  // v0.54 (P1-10): switching bots reloads that bot's draft (if any).
  useEffect(() => {
    if (!bot) return;
    try {
      const draft = composerDraftsStore.list().find((d) => d.value.botId === bot.id) ?? null;
      draftIdRef.current = draft?.id ?? null;
      setInput(draft?.value.text ?? '');
      inputRef.current = draft?.value.text ?? '';
    } catch {
      draftIdRef.current = null;
      setInput('');
    }
  }, [bot?.id]);

  // --- voice state ---
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [workletReady, setWorkletReady] = useState(false);
  const [voiceOn, setVoiceOn] = useState(false);
  // v0.59: call-view state — live transcript lines + call status
  // (connecting/active/ended) rendered by CallView.
  const [voiceTranscripts, setVoiceTranscripts] = useState<CallTranscriptLine[]>([]);
  const [callStatus, setCallStatus] = useState<CallStatus>('ended');
  // v0.59: dictation (mic button in the composer) — PCM16 frames
  // captured with the same pcm-capture worklet, sent once via
  // `voice:dictation`, transcript inserted into the input box.
  const [dictating, setDictating] = useState(false);
  const [dictationBusy, setDictationBusy] = useState(false);
  const dictationStreamRef = useRef<MediaStream | null>(null);
  const dictationCtxRef = useRef<AudioContext | null>(null);
  const dictationFramesRef = useRef<string[]>([]);
  // Current composer text, mirrored for async dictation callbacks
  // (the `input` state in their closure may be stale).
  const inputRef = useRef('');
  // P0-1: surface the user is on during the call + last voice-call
  // tool the model asked for (shown, not executed, in the renderer).
  const [voiceSurface, setVoiceSurface] = useState<VoiceSurfaceOption>('desk');
  const [voiceLastTool, setVoiceLastTool] = useState<string | null>(null);
  // v0.95 (Team D3): realtime voice panel — 2-way conversation state
  // (RealtimeSession in main). `rtOnRef` marks that the live mic
  // frames go to the realtime session, not the old voice call.
  const [rtState, setRtState] = useState<RealtimePanelState>('idle');
  const [rtProvider, setRtProvider] = useState<RealtimeProviderOption>(
    bot?.providerId === 'gemini' ? 'gemini' : 'openai',
  );
  const [rtTurnMode, setRtTurnMode] = useState<RealtimeTurnModeOption>('server_vad');
  const [rtBargeIns, setRtBargeIns] = useState(0);
  const [rtTalkHeld, setRtTalkHeld] = useState(false);
  // v0.96 (Team T5 — voice live): per-adapter health + persisted
  // session id for the panel (fetched after connect + each turn,
  // when the first-audio latency becomes known).
  const [rtHealth, setRtHealth] = useState<RealtimeAdapterHealth | null>(null);
  const [rtSessionId, setRtSessionId] = useState<string | undefined>(undefined);
  const rtOnRef = useRef(false);
  // v0.96 (Team T5): fetch per-adapter health from main (best-effort
  // — the panel works without it; the IPC may not exist yet in an
  // older main, hence the typeof guard).
  const refreshRtHealth = async () => {
    if (!bot) return;
    if (typeof window.openBot.voiceRealtimeHealth !== 'function') return;
    try {
      const res = await window.openBot.voiceRealtimeHealth(bot.id);
      if (res?.ok && res.health && typeof res.health === 'object') {
        setRtHealth(res.health as RealtimeAdapterHealth);
      }
      if (res?.ok && typeof res.sessionId === 'string') setRtSessionId(res.sessionId);
    } catch {
      // Health is best-effort — the panel works without it.
    }
  };
  const [memoRecording, setMemoRecording] = useState(false);
  const [memoBusy, setMemoBusy] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const voiceCtxRef = useRef<AudioContext | null>(null);
  // The App-level error callback changes identity every render; keep it in
  // a ref so the voice subscription effect below does not re-run.
  const onVoiceErrorRef = useRef(onVoiceError);
  onVoiceErrorRef.current = onVoiceError;

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, toolEvents, status]);

  useEffect(() => {
    if (!bot) return;
    let alive = true;
    const api = window.openBot;
    // The v0.4 voice IPC may not be exposed yet while the main process is
    // being updated in parallel; without it, voice stays hidden.
    if (typeof api.voiceAvailable !== 'function') return;
    void api.voiceAvailable(bot.id).then((r) => {
      if (alive) setVoiceAvailable(r.available);
    });
    // Probe the AudioWorklet once: if it cannot load, the voice-call
    // button stays hidden and only the voice memo remains available.
    // v0.55: the worklet loads from a Vite-emitted file asset (`?url`)
    // — same origin 'self', so the CSP `script-src 'self'` allows it.
    // It used to load from a blob URL, which the CSP blocked at app
    // load (Chromium checks AudioWorklet.addModule against script-src,
    // not worker-src).
    const probeWorklet = async () => {
      try {
        const probe = new OfflineAudioContext(1, 1, 16000);
        await probe.audioWorklet.addModule(workletUrl);
        if (alive) setWorkletReady(true);
      } catch {
        if (alive) setWorkletReady(false);
      }
    };
    void probeWorklet();
    const offTranscript = api.onVoiceTranscript(({ botId, text, isFinal }) => {
      if (botId !== bot.id) return;
      // v0.59: live transcript goes to the call view (interim lines
      // update in place, final lines close the turn) and, as before,
      // a final line is also inserted into the composer.
      setVoiceTranscripts((prev) => appendCallTranscript(prev, { text, isFinal, at: Date.now() }));
      if (isFinal) setInput((prev) => (prev ? `${prev} ` : '') + text);
    });
    const offAudio = api.onVoiceAudio(({ botId, audioBase64 }) => {
      if (botId !== bot.id) return;
      // PCM16 24 kHz mono -> play through the speakers.
      const bytes = Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0));
      const pcm = new Int16Array(bytes.buffer);
      const ctx = (audioCtxRef.current ??= new AudioContext({ sampleRate: 24000 }));
      const buf = ctx.createBuffer(1, pcm.length, 24000);
      const out = buf.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start();
    });
    const offError = api.onVoiceError(({ botId, message }) => {
      if (botId !== bot.id) return;
      setVoiceOn(false);
      setCallStatus('ended');
      setVoiceLastTool(null);
      onVoiceErrorRef.current?.(message);
    });
    const offToolCall = api.onVoiceToolCall(({ botId, call, outcome }) => {
      if (botId !== bot.id) return;
      const name =
        call && typeof call === 'object' && 'name' in call
          ? String((call as { name?: unknown }).name ?? '')
          : '';
      if (!name) return;
      // v0.56: main executes the voice tool through the harness and
      // returns the outcome — a failed tool shows its reason, not
      // just the tool name.
      const kind = (outcome as { kind?: unknown } | undefined)?.kind;
      const err = (outcome as { error?: unknown } | undefined)?.error;
      setVoiceLastTool(
        kind && kind !== 'served'
          ? `${name} — ${typeof err === 'string' ? err : String(kind)}`.slice(0, 120)
          : name,
      );
    });
    // v0.95 (Team D3): realtime session state / interruption events
    // for the realtime panel (transcripts still arrive on the
    // voice:transcript channel above and land in the call view).
    const offRealtimeState =
      typeof api.onVoiceRealtimeState === 'function'
        ? api.onVoiceRealtimeState(({ botId, kind, state, source }) => {
            if (botId !== bot.id) return;
            if (kind === 'state' && typeof state === 'string') {
              const known: RealtimePanelState[] = [
                'idle',
                'connecting',
                'listening',
                'speaking',
                'interrupted',
                'reconnecting',
                'closed',
              ];
              if ((known as string[]).includes(state)) {
                setRtState(state as RealtimePanelState);
              }
              if (state === 'closed') rtOnRef.current = false;
            }
            if (kind === 'interrupted') {
              setRtBargeIns((n) => n + 1);
              void source;
            }
            // v0.96 (Team T5): a finished turn means audio arrived —
            // refresh health so first-audio latency shows.
            if (kind === 'turn') void refreshRtHealth();
          })
        : () => {};
    return () => {
      alive = false;
      offTranscript();
      offAudio();
      offError();
      offToolCall();
      offRealtimeState();
      void api.voiceDisconnect(bot.id);
      if (typeof api.voiceRealtimeDisconnect === 'function') {
        void api.voiceRealtimeDisconnect(bot.id);
      }
      voiceStreamRef.current?.getTracks().forEach((tr) => tr.stop());
      voiceStreamRef.current = null;
      if (voiceCtxRef.current) {
        void voiceCtxRef.current.close().catch(() => undefined);
        voiceCtxRef.current = null;
      }
      // v0.59: a dictation in progress must not keep the mic open
      // after the view is gone.
      dictationStreamRef.current?.getTracks().forEach((tr) => tr.stop());
      dictationStreamRef.current = null;
      if (dictationCtxRef.current) {
        void dictationCtxRef.current.close().catch(() => undefined);
        dictationCtxRef.current = null;
      }
    };
  }, [bot?.id]);

  // v0.56: register this chat view as a voice surface in main (the
  // surface on record drives the session-instructions guidance and
  // the spoken-reply length cap). Changing the surface in the select
  // below re-registers; closing the view unregisters so main drops
  // the listener.
  const voiceSurfaceIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!bot) return;
    const api = window.openBot;
    if (typeof api.voiceSurfaceRegister !== 'function') return;
    let alive = true;
    void api.voiceSurfaceRegister(bot.id, voiceSurface, 'chat').then((r) => {
      if (alive && r.ok && r.surfaceId) voiceSurfaceIdRef.current = r.surfaceId;
    });
    return () => {
      alive = false;
      const id = voiceSurfaceIdRef.current;
      voiceSurfaceIdRef.current = null;
      if (id && typeof api.voiceSurfaceUnregister === 'function') {
        void api.voiceSurfaceUnregister(id);
      }
    };
  }, [bot?.id, voiceSurface]);

  // v0.62 (UI-13): apply a command-palette insert exactly once — append
  // to the current composer text (never overwrite what the user typed)
  // and return focus to the textarea so they can keep typing. This MUST
  // live above the `if (!bot)` early return below: a hook after that
  // return changes the hook count between the bot=null render (while
  // bots load) and the bot-selected render, and React crashes the whole
  // app with error #310 on reload (found by the UI-13 smoke).
  useEffect(() => {
    if (!bot || !externalInsert || appliedInsertNonceRef.current === externalInsert.nonce) return;
    appliedInsertNonceRef.current = externalInsert.nonce;
    // `onInputChange` is declared below the early return; the effect
    // callback only runs after the render completes, so the binding is
    // initialised by then. The nonce guard above is what prevents
    // double-applies, so onInputChange stays out of the deps.
    onInputChange(`${inputRef.current ?? ''}${externalInsert.text}`);
    requestAnimationFrame(() => textareaRef.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalInsert, bot?.id]);

  if (!bot) {
    return (
      <div className="main">
        <div className="empty">{t('chat.noBotSelected')}</div>
      </div>
    );
  }

  const toolLabel = (call: ToolCallView): string =>
    String(call.name ?? call.tool ?? t('chat.unknownTool'));

  /**
   * v0.6: screenshot preview — the computer_screenshot tool result carries
   * a small JPEG thumbnail (base64). Parse defensively; anything else
   * renders as plain text like before.
   */
  const screenshotThumbnail = (ev: ToolEvent): string | null => {
    if ((ev.call.name ?? ev.call.tool) !== 'computer_screenshot') return null;
    if (!ev.done || ev.result === undefined || ev.result === null) return null;
    try {
      const output =
        typeof ev.result === 'string'
          ? ev.result
          : (ev.result as { output?: unknown }).output;
      if (typeof output !== 'string') return null;
      const parsed = JSON.parse(output) as { thumbnailBase64?: unknown };
      return typeof parsed.thumbnailBase64 === 'string' && parsed.thumbnailBase64.length > 0
        ? parsed.thumbnailBase64
        : null;
    } catch {
      return null;
    }
  };

  const send = () => {
    // v0.63 (vision channel): images travel as VisionAttachment, not
    // as a text note — validate the limits first (friendly notice in
    // the composer, never a send-then-fail), then build the text from
    // the remaining (text/other) attachments only. An image-only
    // message has empty text and is still sendable.
    const visionCheck = validateVisionItems(attachments);
    if (!visionCheck.ok) {
      setAttachNotice(visionNotice(visionCheck));
      return;
    }
    const vision = buildVisionAttachments(attachments);
    // v0.60 (UI-7): attachments travel inside the message text — as
    // `@files <rel-path>` for in-workspace files (coordinator resolves
    // them) or as inlined content / a note (composer.ts) otherwise.
    // Images are skipped here (imagesAsVision) — they ride the vision
    // channel above.
    const blocks = buildAttachmentBlocks(
      attachments,
      {
        truncatedNote: (taken, total) => t('chat.attachmentTruncated', { taken, total }),
        imageNote: (name, size) => t('chat.imageAttachedNote', { name, size }),
        unreadableNote: (name) => t('chat.fileNotReadable', { name }),
      },
      { imagesAsVision: true },
    );
    const text = buildSendText(input, blocks);
    if ((!text && vision.length === 0) || status !== 'idle') return;
    // v0.54 (P1-10): after sending, delete this bot's draft.
    try {
      if (draftIdRef.current) composerDraftsStore.remove(draftIdRef.current);
    } catch {
      // Ignore it — a failed draft delete does not block sending.
    }
    draftIdRef.current = null;
    setInput('');
    inputRef.current = '';
    setAttachments([]);
    setAttachNotice(null);
    setAutocomplete(null);
    onSend(text, vision.length > 0 ? vision : undefined);
  };

  /** Friendly composer notice for a vision-limit violation (i18n, no bytes). */
  const visionNotice = (issue: Extract<VisionValidationResult, { ok: false }>): string => {
    switch (issue.reason) {
      case 'too-many-images':
        return t('chat.visionImageTooMany', { max: String(VISION_MAX_IMAGES), name: issue.name });
      case 'image-too-large':
        return t('chat.visionImageTooLarge', {
          name: issue.name,
          size: formatFileSize(issue.size),
          max: formatFileSize(VISION_MAX_IMAGE_BYTES),
        });
      case 'images-too-large-total':
        return t('chat.visionImagesTooLargeTotal', {
          max: formatFileSize(VISION_MAX_TOTAL_BYTES),
          name: issue.name,
        });
      case 'image-format-unsupported':
        return t('chat.visionImageUnsupported', { name: issue.name });
      case 'image-unreadable':
        return t('chat.visionImageUnreadable', { name: issue.name });
    }
  };

  /** v0.54 (P1-10): typing saves the draft (a new UUID key is created first, then updated). */
  const onInputChange = (value: string) => {
    setInput(value);
    inputRef.current = value;
    if (!bot) return;
    try {
      if (!value.trim()) {
        if (draftIdRef.current) composerDraftsStore.remove(draftIdRef.current);
        draftIdRef.current = null;
        return;
      }
      if (draftIdRef.current) {
        if (!composerDraftsStore.update(draftIdRef.current, { botId: bot.id, text: value })) {
          draftIdRef.current = composerDraftsStore.create({ botId: bot.id, text: value });
        }
      } else {
        draftIdRef.current = composerDraftsStore.create({ botId: bot.id, text: value });
      }
    } catch {
      // A failed draft save (telemetry already reported) still lets the user keep typing.
    }
  };

  // --- v0.60 (UI-6): autocomplete -------------------------------------
  /** Recompute the popup for `value` with the caret at `cursor`. */
  const updateAutocomplete = (value: string, cursor: number) => {
    const trigger = detectTrigger(value, cursor);
    if (!trigger) {
      setAutocomplete(null);
      return;
    }
    const items =
      trigger.kind === 'slash'
        ? slashItems(slashCommands, trigger.query)
        : mentionItems(trigger.query, (kind) =>
            kind === 'files' ? t('chat.mentionFilesDesc') : t('chat.mentionDocsDesc'),
          );
    // No match: close the popup — except a slash trigger with an empty
    // registry, which stays open on the "no commands yet" hint row.
    if (items.length === 0) {
      if (trigger.kind === 'slash' && slashCommands.length === 0) {
        setAutocomplete({ trigger, items, activeIndex: 0 });
        return;
      }
      setAutocomplete(null);
      return;
    }
    setAutocomplete({ trigger, items, activeIndex: 0 });
  };

  /** Insert the chosen completion, restore the caret, close the popup. */
  const chooseCompletion = (item: AutocompleteItem) => {
    if (!autocomplete) return;
    const { text, cursor } = applyCompletion(input, autocomplete.trigger, item.insertText);
    setAutocomplete(null);
    onInputChange(text);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(cursor, cursor);
    });
  };

  /** Keyboard navigation while the popup is open; returns true when handled. */
  const handleAutocompleteKey = (e: { key: string; preventDefault: () => void }): boolean => {
    if (!autocomplete) return false;
    if (e.key === 'Escape') {
      e.preventDefault();
      setAutocomplete(null);
      return true;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (autocomplete.items.length === 0) return true;
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      const next =
        (autocomplete.activeIndex + dir + autocomplete.items.length) % autocomplete.items.length;
      setAutocomplete({ ...autocomplete, activeIndex: next });
      return true;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && autocomplete.items.length > 0) {
      e.preventDefault();
      chooseCompletion(autocomplete.items[autocomplete.activeIndex]!);
      return true;
    }
    return false;
  };

  // --- v0.60 (UI-7): attachments --------------------------------------
  /** Prepare dropped / picked / pasted files for the next message. */
  const addFiles = async (files: File[] | FileList) => {
    if (!bot) return;
    const list = [...files];
    let next = attachments;
    for (const file of list) {
      if (next.length >= ATTACHMENT_MAX_ITEMS) {
        setAttachNotice(t('chat.attachmentMaxItems', { max: String(ATTACHMENT_MAX_ITEMS) }));
        break;
      }
      const kind = classifyAttachment(file.name);
      // Electron exposes the host path on File; a plain browser leaves
      // it undefined — then the file is treated as outside the workspace.
      const filePath = (file as File & { path?: unknown }).path;
      const relPath =
        typeof filePath === 'string' ? relativeWorkspacePath(bot.workspaceDir, filePath) : null;
      const base: AttachmentSendItem = {
        name: file.name,
        size: file.size,
        kind,
        relPath,
        content: null,
        truncated: false,
        takenBytes: 0,
        totalBytes: file.size,
        readError: false,
        dataBase64: null,
      };
      // v0.63 (vision channel): images are read as base64 NOW (the
      // bytes travel with the message) and refused here — with a
      // friendly notice — when they break a vision limit, instead of
      // being sent and failing in main/core. SVG/BMP/AVIF are images
      // but no vision provider takes them (see composer.ts).
      if (kind === 'image') {
        if (!visionMimeTypeForFile(file.name)) {
          setAttachNotice(t('chat.visionImageUnsupported', { name: file.name }));
          continue;
        }
        const imageCount = next.filter((a) => a.kind === 'image').length;
        if (imageCount >= VISION_MAX_IMAGES) {
          setAttachNotice(
            t('chat.visionImageTooMany', { max: String(VISION_MAX_IMAGES), name: file.name }),
          );
          continue;
        }
        if (file.size > VISION_MAX_IMAGE_BYTES) {
          setAttachNotice(
            t('chat.visionImageTooLarge', {
              name: file.name,
              size: formatFileSize(file.size),
              max: formatFileSize(VISION_MAX_IMAGE_BYTES),
            }),
          );
          continue;
        }
        const imagesTotal = next
          .filter((a) => a.kind === 'image')
          .reduce((sum, a) => sum + a.size, 0);
        if (imagesTotal + file.size > VISION_MAX_TOTAL_BYTES) {
          setAttachNotice(
            t('chat.visionImagesTooLargeTotal', {
              max: formatFileSize(VISION_MAX_TOTAL_BYTES),
              name: file.name,
            }),
          );
          continue;
        }
        try {
          const dataBase64 = arrayBufferToBase64(await file.arrayBuffer());
          next = [...next, { ...base, dataBase64 }];
        } catch {
          setAttachNotice(t('chat.visionImageUnreadable', { name: file.name }));
        }
        continue;
      }
      if (kind === 'text' && relPath === null) {
        if (wouldExceedTotal(next, file.size)) {
          setAttachNotice(
            t('chat.attachmentTotalLimit', { max: formatFileSize(500 * 1024), name: file.name }),
          );
          continue;
        }
        try {
          const raw = await file.text();
          const cut = truncateTextContent(raw, ATTACHMENT_MAX_FILE_BYTES);
          next = [
            ...next,
            { ...base, content: cut.content, truncated: cut.truncated, takenBytes: cut.takenBytes, totalBytes: cut.totalBytes },
          ];
        } catch {
          next = [...next, { ...base, readError: true }];
        }
      } else {
        next = [...next, base];
      }
    }
    setAttachments(next);
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
    setAttachNotice(null);
  };

  const stopVoiceCapture = async () => {
    // v0.95 (Team D3): a live realtime session stops through its own
    // disconnect (its mic frames go to another IPC channel).
    if (rtOnRef.current) {
      await stopRealtime();
      return;
    }
    voiceStreamRef.current?.getTracks().forEach((tr) => tr.stop());
    voiceStreamRef.current = null;
    if (voiceCtxRef.current) {
      await voiceCtxRef.current.close().catch(() => undefined);
      voiceCtxRef.current = null;
    }
    await window.openBot.voiceDisconnect(bot.id);
    setVoiceOn(false);
    setCallStatus('ended');
    setVoiceLastTool(null);
    playEarcon('disconnect');
  };

  /**
   * Shared mic capture for both voice paths (v0.95, Team D3): get the
   * mic, load the pcm-capture worklet, and forward each PCM16 frame
   * to main — to `voice:audio` for the old call, to
   * `voice:realtime-audio` for a realtime session. Returns false
   * when the mic / worklet could not start (the caller disconnects
   * the session it just opened).
   */
  const startMicCapture = async (route: 'call' | 'realtime'): Promise<boolean> => {
    let stream: MediaStream;
    let ctx: AudioContext;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      ctx = new AudioContext({ sampleRate: 16000 });
    } catch {
      return false;
    }
    try {
      // v0.55: the worklet loads from a file asset (`?url`) — see the probe above.
      await ctx.audioWorklet.addModule(workletUrl);
    } catch {
      stream.getTracks().forEach((tr) => tr.stop());
      await ctx.close().catch(() => undefined);
      setWorkletReady(false);
      return false;
    }
    const node = new AudioWorkletNode(ctx, 'pcm-capture');
    node.port.onmessage = (e: MessageEvent<{ audioBase64: string }>) => {
      if (route === 'realtime') {
        window.openBot.voiceRealtimeSendAudio(bot.id, e.data.audioBase64);
      } else {
        window.openBot.voiceSendAudio(bot.id, e.data.audioBase64);
      }
    };
    ctx.createMediaStreamSource(stream).connect(node);
    voiceStreamRef.current = stream;
    voiceCtxRef.current = ctx;
    return true;
  };

  const stopMicCapture = async () => {
    voiceStreamRef.current?.getTracks().forEach((tr) => tr.stop());
    voiceStreamRef.current = null;
    if (voiceCtxRef.current) {
      await voiceCtxRef.current.close().catch(() => undefined);
      voiceCtxRef.current = null;
    }
  };

  // Capture mic audio as PCM16 16 kHz via AudioWorklet and forward each
  // frame to the main process.
  const toggleVoice = async () => {
    if (voiceOn) {
      await stopVoiceCapture();
      return;
    }
    setCallStatus('connecting');
    setVoiceTranscripts([]);
    const res = await window.openBot.voiceConnect(bot.id);
    if (!res.ok) {
      setCallStatus('ended');
      onVoiceError?.(res.error ?? t('voice.connectError'));
      return;
    }
    if (!(await startMicCapture('call'))) {
      await window.openBot.voiceDisconnect(bot.id);
      setCallStatus('ended');
      onVoiceError?.(t('voice.connectError'));
      return;
    }
    setVoiceOn(true);
    setCallStatus('active');
    setVoiceLastTool(null);
    playEarcon('connect');
  };

  /**
   * v0.95 (Team D3): start a realtime 2-way session (RealtimeSession
   * in main — provider adapter + barge-in + turn-taking) instead of
   * the old voice call. Transcript/audio still arrive on the
   * voice:* channels, so the call view below keeps working.
   */
  const startRealtime = async () => {
    if (typeof window.openBot.voiceRealtimeConnect !== 'function') return;
    setCallStatus('connecting');
    setRtState('connecting');
    setVoiceTranscripts([]);
    setRtBargeIns(0);
    const res = await window.openBot.voiceRealtimeConnect(bot.id, rtProvider, rtTurnMode);
    if (!res.ok) {
      setCallStatus('ended');
      setRtState('idle');
      onVoiceError?.(res.error ?? t('voice.connectError'));
      return;
    }
    if (!(await startMicCapture('realtime'))) {
      await window.openBot.voiceRealtimeDisconnect(bot.id);
      setCallStatus('ended');
      setRtState('idle');
      onVoiceError?.(t('voice.connectError'));
      return;
    }
    rtOnRef.current = true;
    setVoiceOn(true);
    setCallStatus('active');
    setRtState((res.state as RealtimePanelState) || 'listening');
    setVoiceLastTool(null);
    void refreshRtHealth();
    playEarcon('connect');
  };

  const stopRealtime = async () => {
    rtOnRef.current = false;
    setRtTalkHeld(false);
    await stopMicCapture();
    if (typeof window.openBot.voiceRealtimeDisconnect === 'function') {
      await window.openBot.voiceRealtimeDisconnect(bot.id);
    }
    setVoiceOn(false);
    setCallStatus('ended');
    setRtState('closed');
    setRtHealth(null);
    setRtSessionId(undefined);
    setVoiceLastTool(null);
    playEarcon('disconnect');
  };

  const handleRealtimeTurnMode = async (mode: RealtimeTurnModeOption) => {
    setRtTurnMode(mode);
    if (rtOnRef.current && typeof window.openBot.voiceRealtimeMode === 'function') {
      await window.openBot.voiceRealtimeMode(bot.id, mode);
    }
  };

  const handleRealtimeTalkHold = async (held: boolean) => {
    setRtTalkHeld(held);
    if (rtOnRef.current && typeof window.openBot.voiceRealtimeTalk === 'function') {
      await window.openBot.voiceRealtimeTalk(bot.id, held);
    }
  };

  /**
   * v0.59: dictation — mic button in the composer. Records with the
   * same pcm-capture worklet as the voice call, but instead of
   * streaming to the realtime session it buffers PCM16 frames and,
   * when the user stops, sends them once through `voice:dictation`
   * (the core dictation flow: PCM16 -> WAV -> provider STT) and
   * inserts the transcript into the composer. Never runs at the same
   * time as a voice call (both need the mic).
   */
  const stopDictation = async () => {
    const frames = dictationFramesRef.current;
    dictationFramesRef.current = [];
    dictationStreamRef.current?.getTracks().forEach((tr) => tr.stop());
    dictationStreamRef.current = null;
    if (dictationCtxRef.current) {
      await dictationCtxRef.current.close().catch(() => undefined);
      dictationCtxRef.current = null;
    }
    setDictating(false);
    const audioBase64 = concatPcm16Base64(frames);
    if (!audioBase64) return;
    setDictationBusy(true);
    try {
      const res = await window.openBot.voiceDictation(bot.id, audioBase64);
      if (res.ok && res.text) {
        onInputChange(insertDictationText(inputRef.current, res.text));
      } else {
        onVoiceError?.(res.error ?? t('voice.dictationError'));
      }
    } finally {
      setDictationBusy(false);
    }
  };

  const toggleDictation = async () => {
    if (dictating) {
      await stopDictation();
      return;
    }
    let stream: MediaStream | undefined;
    let ctx: AudioContext | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      ctx = new AudioContext({ sampleRate: 16000 });
      await ctx.audioWorklet.addModule(workletUrl);
    } catch {
      stream?.getTracks().forEach((tr) => tr.stop());
      await ctx?.close().catch(() => undefined);
      setWorkletReady(false);
      onVoiceError?.(t('voice.dictationError'));
      return;
    }
    const node = new AudioWorkletNode(ctx, 'pcm-capture');
    dictationFramesRef.current = [];
    node.port.onmessage = (e: MessageEvent<{ audioBase64: string }>) => {
      dictationFramesRef.current.push(e.data.audioBase64);
    };
    ctx.createMediaStreamSource(stream).connect(node);
    dictationStreamRef.current = stream;
    dictationCtxRef.current = ctx;
    setDictating(true);
  };

  // Voice memo: record webm/opus with MediaRecorder, send it for
  // transcription, and insert the returned text into the input box.
  const toggleMemo = async () => {
    if (memoRecording) {
      mediaRecorderRef.current?.stop();
      setMemoRecording(false);
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : undefined;
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = async () => {
      stream.getTracks().forEach((tr) => tr.stop());
      setMemoBusy(true);
      try {
        const buf = await new Blob(chunks).arrayBuffer();
        const res = await window.openBot.transcribeMemo(bot.id, arrayBufferToBase64(buf));
        if (res.ok && res.text) {
          setInput((prev) => (prev ? `${prev} ` : '') + res.text);
        } else {
          onVoiceError?.(res.error ?? t('voice.memoError'));
        }
      } finally {
        setMemoBusy(false);
      }
    };
    mediaRecorderRef.current = rec;
    rec.start();
    setMemoRecording(true);
  };

  return (
    <div className="main">
      <header className="chat-header">
        {/* v0.62 (UI-13): avatar — same coloured initial as the sidebar. */}
        <span className="bot-avatar" style={{ background: botColor(bot.color) }} aria-hidden="true">
          {botInitial(bot.name)}
        </span>
        <div>
          <h2>{bot.name}</h2>
          <span className="sub">{bot.providerId} · {bot.model || t('chat.defaultModel')}{sourceLabel ? ` · ${sourceLabel}` : ''}{bot.autoApprove ? ` · ${t('chat.autoApprove')}` : ''}</span>
        </div>
        {(onSwitchModel || ttsAvailable || browserVoices.length > 0) && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            {/* v0.82: TTS voice/rate — only when a real engine exists.
                v0.83: also shown for the browser-voice fallback (no
                system engine) — the options are then the browser's
                voices, and the hint names the source honestly. */}
            {(ttsAvailable || browserVoices.length > 0) && (
              <span className="tts-controls" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <label htmlFor="tts-voice">{t('tts.voice')}</label>
                <select
                  id="tts-voice"
                  data-testid="tts-voice"
                  value={ttsVoice}
                  onChange={(e) => {
                    setTtsVoice(e.target.value);
                    try {
                      window.localStorage.setItem('open-bot:tts-voice', e.target.value);
                    } catch {
                      // Private mode — the choice just does not persist.
                    }
                  }}
                >
                  <option value="">{t('tts.voiceAuto')}</option>
                  {(ttsAvailable ? ttsVoices : browserVoices).map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
                {!ttsAvailable && browserVoices.length > 0 && (
                  <span className="hint" data-testid="tts-browser-source">
                    {t('chat.ttsBrowserSource')}
                  </span>
                )}
                <label htmlFor="tts-rate">{t('tts.rate')}</label>
                <select
                  id="tts-rate"
                  data-testid="tts-rate"
                  value={String(ttsRate)}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    setTtsRate(next);
                    try {
                      window.localStorage.setItem('open-bot:tts-rate', String(next));
                    } catch {
                      // Private mode — the choice just does not persist.
                    }
                  }}
                >
                  <option value="0.75">0.75x</option>
                  <option value="1">1x</option>
                  <option value="1.25">1.25x</option>
                  <option value="1.5">1.5x</option>
                </select>
              </span>
            )}
            {onSwitchModel && (
              <button className="btn secondary" onClick={onSwitchModel}>{t('modelPicker.changeModel')}</button>
            )}
          </div>
        )}
      </header>

      <div className="chat-body" ref={bodyRef}>
        {messages.length === 0 && (
          <p className="empty">{t('chat.emptyGreeting', { name: bot.name })}</p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {/* v0.63 (vision channel): user bubbles carry their images
                as thumbnails (data URL built from the bubble's own
                base64 — never logged); click to view large. v0.65:
                history reloads re-read the stored images, so reloaded
                bubbles show thumbnails too; a stored image whose file
                is gone/corrupt arrives with `unavailable: true` and
                renders as a placeholder (name + note) instead of a
                broken thumbnail. Pre-v0.65 messages have no
                `attachments` at all and still show the old metadata
                line in the text. */}
            {m.role === 'user' && m.attachments && m.attachments.length > 0 && (
              <div className="msg-images">
                {m.attachments.map((att, i) =>
                  att.unavailable || !att.data ? (
                    <div
                      key={`${att.name ?? 'image'}-${i}`}
                      className="msg-image-unavailable"
                      title={att.name ?? t('chat.attachedImageFallback')}
                    >
                      <span aria-hidden="true">🖼️</span>
                      <span>{att.name ?? t('chat.attachedImageFallback')}</span>
                      <span>{t('chat.imageUnavailable')}</span>
                    </div>
                  ) : (
                    <button
                      key={`${att.name ?? 'image'}-${i}`}
                      type="button"
                      className="msg-image-thumb-btn"
                      onClick={() =>
                        setPreviewImage({
                          src: `data:${att.mimeType};base64,${att.data}`,
                          name: att.name ?? t('chat.attachedImageFallback'),
                        })
                      }
                      title={att.name ?? t('chat.attachedImageFallback')}
                    >
                      <img
                        className="msg-image-thumb"
                        src={`data:${att.mimeType};base64,${att.data}`}
                        alt={att.name ?? t('chat.attachedImageFallback')}
                      />
                    </button>
                  ),
                )}
              </div>
            )}
            {/* v0.59 (UI-1): assistant replies render as safe Markdown
                (code blocks, tables, links); user/system text stays
                plain so typed input is never reinterpreted. */}
            {m.role === 'assistant' ? <Markdown text={m.text} /> : m.text}
            {/* v0.60 (UI-8): per-turn token/usage footer — only on
                assistant messages that carry a usage (attached by App
                from the usage diff of that turn; history reloads have
                none, so old messages simply show no footer). */}
            {m.role === 'assistant' && m.usage && (
              <div className="msg-usage" data-testid="turn-usage">
                {t('chat.turnUsage', {
                  input: formatTokenCount(m.usage.inputTokens),
                  output: formatTokenCount(m.usage.outputTokens),
                })}
                {m.usage.costUsd !== null && <> · {formatTurnCostUsd(m.usage.costUsd)}</>}
              </div>
            )}
            {/* v0.81: TTS — read this answer aloud (local engine only;
                when the machine has none, the notice says so).
                v0.83: while it speaks, the button becomes Stop — it
                kills the utterance (system engine or browser voice)
                and resets the state immediately. */}
            {m.role === 'assistant' && m.text && (
              <button
                className="btn secondary msg-speak"
                data-testid={`speak-${m.id}`}
                onClick={() =>
                  void (speakingId === m.id ? stopSpeaking() : speakMessage(m.id, m.text))
                }
                title={speakingId === m.id ? t('chat.stopSpeakTitle') : t('chat.speakTitle')}
              >
                {speakingId === m.id ? `⏹ ${t('chat.stopSpeak')}` : `🔊 ${t('chat.speak')}`}
              </button>
            )}
          </div>
        ))}
        {toolEvents.map((ev) => (
          <details key={ev.id} className="tool-card" open={!ev.done}>
            <summary>
              🔧 {toolLabel(ev.call)} {ev.done ? (ev.stopped ? t('chat.toolStopped') : t('chat.toolDone')) : t('chat.toolRunning')}
            </summary>
            <pre>{JSON.stringify(ev.call.args ?? ev.call.arguments ?? ev.call, null, 2)}</pre>
            {(() => {
              const thumb = screenshotThumbnail(ev);
              return thumb ? (
                <img
                  src={`data:image/jpeg;base64,${thumb}`}
                  alt="Screenshot"
                  style={{ maxWidth: '100%', border: '1px solid var(--border)', borderRadius: 6 }}
                />
              ) : null;
            })()}
            {ev.done && ev.result !== undefined && (
              <pre className="result">{t('chat.toolResult')} {typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result, null, 2)}</pre>
            )}
          </details>
        ))}
        {status === 'thinking' && <div className="status">{t('chat.thinking')}</div>}
        {status === 'tool' && <div className="status">{t('chat.toolWorking')}</div>}
        {ttsNotice && <p className="hint" data-testid="tts-notice">{ttsNotice}</p>}
      </div>

      <div className="chat-input">
        {/* v0.60 (UI-6 + UI-7): composer box — attachment chips, the
            textarea, the autocomplete popup above it, and the drop hint.
            The chat bubbles above keep their 78% max-width. */}
        <div
          className={`composer-box${dragOver ? ' drag-over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer.files.length > 0) void addFiles(e.dataTransfer.files);
          }}
        >
          {attachments.length > 0 && (
            <div className="composer-chips">
              {attachments.map((att, i) => (
                <span
                  key={`${att.name}-${i}`}
                  className="composer-chip"
                  title={att.relPath ?? att.name}
                >
                  <span aria-hidden="true">
                    {att.kind === 'image' ? '🖼️' : att.kind === 'text' ? '📄' : '📎'}
                  </span>
                  <span className="composer-chip-name">{att.name}</span>
                  <span className="composer-chip-size">{formatFileSize(att.size)}</span>
                  <button
                    type="button"
                    className="composer-chip-remove"
                    onClick={() => removeAttachment(i)}
                    title={t('chat.removeAttachment')}
                    aria-label={t('chat.removeAttachment')}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              onInputChange(e.target.value);
              updateAutocomplete(
                e.target.value,
                e.target.selectionStart ?? e.target.value.length,
              );
            }}
            onSelect={(e) =>
              updateAutocomplete(input, e.currentTarget.selectionStart ?? input.length)
            }
            onKeyDown={(e) => {
              if (handleAutocompleteKey(e)) return;
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            onPaste={(e) => {
              const files = e.clipboardData?.files;
              if (files && files.length > 0) {
                e.preventDefault();
                void addFiles(files);
              }
            }}
            placeholder={t('chat.inputPlaceholder')}
            disabled={status !== 'idle'}
          />
          {autocomplete && (
            <ComposerAutocomplete
              items={autocomplete.items}
              activeIndex={autocomplete.activeIndex}
              emptyText={
                autocomplete.trigger.kind === 'slash' ? t('chat.noSlashCommands') : null
              }
              onSelect={chooseCompletion}
              onHover={(index) =>
                setAutocomplete((prev) => (prev ? { ...prev, activeIndex: index } : prev))
              }
            />
          )}
          {dragOver && <div className="composer-drop-hint">{t('chat.dropFilesHere')}</div>}
          {attachNotice && (
            <div className="status" data-testid="attach-notice">
              {attachNotice}
            </div>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <button
          className="btn secondary"
          data-testid="attach-button"
          onClick={() => fileInputRef.current?.click()}
          disabled={status !== 'idle'}
          title={t('chat.attachHint')}
        >
          📎
        </button>
        {voiceAvailable && workletReady && (
          <button
            className="btn"
            onClick={() => void toggleVoice()}
            disabled={status !== 'idle' || dictating}
            title={t('voice.callHint')}
            aria-pressed={voiceOn}
          >
            {voiceOn ? t('voice.stopCall') : t('voice.startCall')}
          </button>
        )}
        {/* v0.59: dictation — mic in the composer. Records PCM16, then
            `voice:dictation` transcribes it into the input box. */}
        {voiceAvailable && (
          <button
            className="btn"
            data-testid="dictation-button"
            onClick={() => void toggleDictation()}
            disabled={status !== 'idle' || voiceOn || memoRecording || dictationBusy}
            title={t('voice.dictationHint')}
            aria-pressed={dictating}
          >
            {dictating ? t('voice.dictationStop') : t('voice.dictationRecord')}
          </button>
        )}
        <button
          className="btn"
          onClick={() => void toggleMemo()}
          disabled={status !== 'idle' || memoBusy}
          title={t('voice.memoHint')}
        >
          {memoRecording ? t('voice.memoStop') : t('voice.memoRecord')}
        </button>
        {/* v0.59 (UI-2): Stop is only offered while a run is in flight;
            the input stays disabled until the run settles, so stopping
            is the only way out of a long or looping run. */}
        {status !== 'idle' && onStop && (
          <button
            className="btn danger"
            data-testid="stop-run-button"
            onClick={() => {
              setStopping(true);
              onStop();
            }}
            disabled={stopping}
            title={t('chat.stop')}
          >
            {stopping ? t('chat.stopping') : t('chat.stop')}
          </button>
        )}
        <button
          className="btn"
          onClick={send}
          disabled={status !== 'idle' || (!input.trim() && attachments.length === 0)}
        >
          {t('chat.send')}
        </button>
      </div>
      {/* v0.59: dedicated call view while a call is live (or just
          ended, so the final transcript stays visible), plus the
          dictation "listening…" status while recording. */}
      {(callStatus !== 'ended' || voiceTranscripts.length > 0) && (
        <CallView
          botId={bot.id}
          botName={bot.name}
          status={voiceOn ? 'active' : callStatus}
          transcripts={voiceTranscripts}
          lastTool={voiceLastTool}
          surface={voiceSurface}
          onSurfaceChange={setVoiceSurface}
          onEndCall={() => void stopVoiceCapture()}
        />
      )}
      {/* v0.95 (Team D3): realtime voice panel — 2-way conversation
          (provider adapter + barge-in + turn-taking). Shown whenever
          voice is available; the panel's Start uses the realtime
          session instead of the old voice call. */}
      {voiceAvailable && (
        <RealtimeVoicePanel
          available={voiceAvailable && workletReady}
          provider={rtProvider}
          turnMode={rtTurnMode}
          state={rtState}
          bargeInCount={rtBargeIns}
          talkHeld={rtTalkHeld}
          adapterHealth={rtHealth}
          transcript={voiceTranscripts.map((l) => ({ text: l.text, isFinal: l.isFinal }))}
          sessionId={rtSessionId}
          onProviderChange={setRtProvider}
          onTurnModeChange={(mode) => void handleRealtimeTurnMode(mode)}
          onStart={() => void startRealtime()}
          onStop={() => void stopRealtime()}
          onInterrupt={() => void window.openBot.voiceRealtimeInterrupt?.(bot.id)}
          onTalkHold={(held) => void handleRealtimeTalkHold(held)}
        />
      )}
      {dictating && (
        <div className="status" data-testid="dictation-listening">
          {t('voice.dictationListening')}
        </div>
      )}
      {dictationBusy && <div className="status">{t('voice.dictationTranscribing')}</div>}
      {/* v0.63 (vision channel): click a thumbnail to view the image
          large. Click the backdrop or the button to close. */}
      {previewImage && (
        <div
          className="image-preview-overlay"
          role="dialog"
          aria-label={previewImage.name}
          onClick={() => setPreviewImage(null)}
        >
          <div className="image-preview-box" onClick={(e) => e.stopPropagation()}>
            <div className="image-preview-head">
              <span className="composer-chip-name">{previewImage.name}</span>
              <button type="button" className="btn secondary" onClick={() => setPreviewImage(null)}>
                {t('chat.closeImagePreview')}
              </button>
            </div>
            <img className="image-preview-img" src={previewImage.src} alt={previewImage.name} />
          </div>
        </div>
      )}
    </div>
  );
}
