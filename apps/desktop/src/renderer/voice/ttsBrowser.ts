/**
 * Browser `speechSynthesis` fallback for TTS (v0.83).
 *
 * Used ONLY when the machine has no system speech engine (the core
 * `TtsHarness` reports `no-engine-available`): Chromium/Electron
 * ships its own voices through `window.speechSynthesis`, so the user
 * can still hear an answer read aloud instead of getting nothing.
 *
 * Rules (honest fallback, same as the core harness):
 * - Only active when `speechSynthesis` exists AND `getVoices()`
 *   returns at least one voice. An empty voice list means "no
 *   fallback" — the UI then shows the honest no-engine notice
 *   instead of pretending a browser voice exists. (Chrome loads
 *   voices asynchronously: `onBrowserVoicesChanged` lets the UI
 *   re-check when the `voiceschanged` event fires.)
 * - `speakWithBrowser()` never throws: every failure is a
 *   `{ spoken: false, reason }` result.
 * - `stopBrowserSpeech()` cancels the queued/spoken utterance
 *   (`speechSynthesis.cancel()`); the in-flight promise resolves
 *   `'stopped'` (the `error` event carries `canceled`/`interrupted`
 *   in Chromium, `onend` in some builds — both map to `stopped`).
 * - The source is always reported to the user (ChatView shows
 *   "giọng trình duyệt" while it speaks) so a browser voice is
 *   never mistaken for the system engine.
 *
 * Self-contained on purpose (no import from `@open-bot/core` — the
 * renderer keeps that boundary, see `types.ts`): `stripForSpeech`
 * mirrors core's `stripMarkdownForSpeech` and
 * `BROWSER_TTS_MAX_CHARS` mirrors `TTS_MAX_CHARS`.
 */

/** Long answers are cut here — same cap as the core harness. */
export const BROWSER_TTS_MAX_CHARS = 5000;
/** One browser utterance gets at most this long (mirrors the core 60 s cap). */
export const BROWSER_TTS_TIMEOUT_MS = 60_000;

export interface BrowserTtsVoice {
  /** Id to store/choose by (`voiceURI`, falling back to `name`). */
  id: string;
  /** Display name (e.g. 'Google Tiếng Việt'). */
  name: string;
  /** Language tag of the voice (e.g. 'vi-VN'). */
  lang: string;
}

export interface BrowserSpeakOptions {
  /** Speech rate multiplier (1 = normal). Clamped to 0.1..10. */
  rate?: number;
  /** BCP-47-ish language tag, e.g. 'vi' or 'en'. */
  lang?: string;
  /** Browser voice id (see `listBrowserVoices()`). */
  voice?: string;
}

export interface BrowserSpeakResult {
  spoken: boolean;
  /**
   * Machine-readable reason when `spoken` is false:
   * `no-browser-speech` | `no-browser-voices` | `empty-text` |
   * `stopped` (cancelled) | `browser-error` | `timeout`.
   */
  reason?: string;
}

/** `window.speechSynthesis` when the runtime has it, else null. Never throws. */
export function getBrowserSpeech(): SpeechSynthesis | null {
  try {
    if (typeof window === 'undefined') return null;
    const synth = window.speechSynthesis;
    return synth ?? null;
  } catch {
    return null;
  }
}

/**
 * Strip Markdown / HTML so the browser voice reads prose, not
 * syntax (mirrors core `stripMarkdownForSpeech`: fences dropped,
 * links keep their text, headings lose `#`, emphasis markers
 * disappear, HTML tags are dropped, whitespace collapses).
 */
export function stripForSpeech(text: string): string {
  let out = String(text ?? '');
  out = out.replace(/```[\s\S]*?```/g, ' ');
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  out = out.replace(/`([^`]*)`/g, '$1');
  out = out.replace(/^#{1,6}\s+/gm, '');
  out = out.replace(/^>\s?/gm, '');
  out = out.replace(/^(\s*)([-*+]|\d+[.)])\s+/gm, '$1');
  out = out.replace(/(\*\*|__)(.*?)\1/g, '$2');
  out = out.replace(/(\*|_)(.*?)\1/g, '$2');
  out = out.replace(/~~(.*?)~~/g, '$1');
  out = out.replace(/<[^>]*>/g, ' ');
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

/** Browser voices available right now (empty when none / no API). */
export function listBrowserVoices(): BrowserTtsVoice[] {
  const synth = getBrowserSpeech();
  if (!synth) return [];
  try {
    return synth.getVoices().map((v) => ({
      id: v.voiceURI || v.name,
      name: v.name,
      lang: v.lang,
    }));
  } catch {
    return [];
  }
}

/** True when the browser offers at least one voice right now. */
export function hasBrowserVoices(): boolean {
  return listBrowserVoices().length > 0;
}

/**
 * Re-check voices when Chromium finishes loading them: call the
 * callback on `voiceschanged`. Returns an unsubscribe function.
 * No-op (returns a no-op unsubscribe) when there is no API.
 */
export function onBrowserVoicesChanged(cb: () => void): () => void {
  const synth = getBrowserSpeech();
  if (!synth) return () => undefined;
  const handler = (): void => {
    cb();
  };
  try {
    synth.addEventListener('voiceschanged', handler);
  } catch {
    try {
      synth.onvoiceschanged = handler;
    } catch {
      return () => undefined;
    }
  }
  return () => {
    try {
      synth.removeEventListener('voiceschanged', handler);
    } catch {
      // Best effort only.
    }
    try {
      if (synth.onvoiceschanged === handler) synth.onvoiceschanged = null;
    } catch {
      // Best effort only.
    }
  };
}

/**
 * Pick a browser voice: exact id match first (`voiceURI` or name,
 * e.g. a stored choice), then a voice whose language starts with
 * `opts.lang` (or the stored id's language prefix), then the first
 * voice. Returns null when the list is empty.
 */
export function pickBrowserVoice(
  voices: SpeechSynthesisVoice[],
  opts?: BrowserSpeakOptions,
): SpeechSynthesisVoice | null {
  if (!Array.isArray(voices) || voices.length === 0) return null;
  const wanted = typeof opts?.voice === 'string' && opts.voice ? opts.voice : '';
  if (wanted) {
    const exact = voices.find((v) => v.voiceURI === wanted || v.name === wanted);
    if (exact) return exact;
  }
  const lang = (opts?.lang ?? wanted.split('-')[0] ?? '').toLowerCase();
  if (lang) {
    const byLang = voices.find((v) => v.lang.toLowerCase().startsWith(lang));
    if (byLang) return byLang;
  }
  return voices[0] ?? null;
}

/**
 * Read text aloud through the browser voice. Never throws.
 * Resolves `{ spoken: true }` on `onend`, `{ spoken: false,
 * reason: 'stopped' }` when cancelled, `'browser-error'` on
 * utterance errors, `'timeout'` after 60 s (the utterance is
 * cancelled then, mirroring the core harness cap).
 */
export function speakWithBrowser(
  text: string,
  opts?: BrowserSpeakOptions,
): Promise<BrowserSpeakResult> {
  const synth = getBrowserSpeech();
  if (!synth) return Promise.resolve({ spoken: false, reason: 'no-browser-speech' });
  const clean = stripForSpeech(text).slice(0, BROWSER_TTS_MAX_CHARS);
  if (!clean) return Promise.resolve({ spoken: false, reason: 'empty-text' });
  let voices: SpeechSynthesisVoice[];
  try {
    voices = synth.getVoices();
  } catch {
    return Promise.resolve({ spoken: false, reason: 'browser-error' });
  }
  if (!Array.isArray(voices) || voices.length === 0) {
    return Promise.resolve({ spoken: false, reason: 'no-browser-voices' });
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: BrowserSpeakResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    let utter: SpeechSynthesisUtterance;
    try {
      utter = new SpeechSynthesisUtterance(clean);
    } catch {
      finish({ spoken: false, reason: 'browser-error' });
      return;
    }
    const picked = pickBrowserVoice(voices, opts);
    // A voice object the runtime rejects (e.g. a stale entry) must
    // not break the utterance — fall back to the default voice.
    try {
      if (picked) utter.voice = picked;
    } catch {
      // Ignore — the utterance speaks with the default voice.
    }
    if (typeof opts?.lang === 'string' && opts.lang) utter.lang = opts.lang;
    if (typeof opts?.rate === 'number' && Number.isFinite(opts.rate)) {
      utter.rate = Math.min(10, Math.max(0.1, opts.rate));
    }
    utter.onend = () => finish({ spoken: true });
    utter.onerror = (ev: SpeechSynthesisErrorEvent) => {
      const code = (ev as { error?: string } | null)?.error;
      finish({
        spoken: false,
        reason: code === 'canceled' || code === 'interrupted' ? 'stopped' : 'browser-error',
      });
    };
    timer = setTimeout(() => {
      try {
        synth.cancel();
      } catch {
        // Already gone.
      }
      finish({ spoken: false, reason: 'timeout' });
    }, BROWSER_TTS_TIMEOUT_MS);
    timer.unref?.();
    try {
      synth.speak(utter);
    } catch {
      finish({ spoken: false, reason: 'browser-error' });
    }
  });
}

/**
 * Cancel the browser utterance that is speaking or queued (v0.83).
 * Returns true only when something was actually speaking/pending.
 * Never throws.
 */
export function stopBrowserSpeech(): boolean {
  const synth = getBrowserSpeech();
  if (!synth) return false;
  let was = false;
  try {
    was = synth.speaking || synth.pending;
  } catch {
    was = false;
  }
  try {
    synth.cancel();
  } catch {
    return false;
  }
  return was;
}
