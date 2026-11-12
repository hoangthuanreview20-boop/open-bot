/**
 * TTS harness (v0.81, local-first).
 *
 * Reads an answer aloud through a local, free speech engine — never a
 * paid TTS service, never a key. The harness tries engines in order
 * and reports honestly when none is available instead of pretending
 * a voice exists:
 *
 *   - `SystemTtsEngine`: a speech binary already on the machine —
 *     `espeak-ng` / `espeak` / `spd-say` / `say` (macOS) / `flite`.
 *     Spawned with argv only (no shell), with a timeout.
 *   - `MockTtsEngine`: records utterances in memory; for tests and
 *     for machines without any engine.
 *
 * `TtsHarness.speak()` never throws: no engine → `{ spoken: false,
 * reason: 'no-engine-available' }`; empty text → `'empty-text'`.
 *
 * Machine fact (checked 2026-11-11): this dev machine had NO local
 * TTS engine at first (`espeak`, `espeak-ng`, `spd-say`, `say`, `flite`,
 * `festival` all absent from PATH and from the apt cache), so the
 * harness honestly reported `no-engine-available`. `apt-get install
 * espeak-ng` (after `apt --fix-broken install` repaired pre-broken
 * gdb/binwalk/imagemagick deps) installed eSpeak NG 1.51 the same
 * day, and the harness now speaks for real — live test
 * `scripts/tts-live-v082/live-test.mjs` passed: `speak()` returned
 * `{ spoken: true, engineId: 'espeak-ng' }` in 109 ms, empty text
 * still reports `empty-text`; `espeak-ng --stdout` synthesised
 * 64,132 bytes of WAV for one sentence, and Vietnamese voices
 * (`vi`, `vi-vn-x-central`, `vi-vn-x-south`) exist.
 * Voice/speed selection (v0.82): `TtsSpeakOptions.voice` picks an
 * eSpeak voice (`-v`), `rate` scales the words-per-minute (`-s`);
 * `listVoices()` lists the engine's voices for a picker UI.
 *
 * Stop (v0.83): `TtsHarness.stop()` kills the utterance that is
 * still speaking (SIGKILL on the spawned engine process) — the
 * in-flight `speak()` promise then resolves
 * `{ spoken: false, reason: 'stopped' }` instead of hanging until
 * the text finishes. A new `speak()` also replaces one still
 * speaking (the old promise resolves `'stopped'`). `stop()` with
 * nothing speaking returns `{ stopped: false }`. The renderer
 * `speechSynthesis` fallback (see
 * `apps/desktop/src/renderer/voice/ttsBrowser.ts`) has its own
 * cancel path — the core harness only stops system engines.
 * Windows PowerShell SAPI is NOT implemented: it cannot be verified
 * on this Linux machine, so the harness stays honest about it
 * (see docs/BEYOND-ROADMAP.md v0.83a).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import * as path from 'node:path';

/** Long answers are cut here — speech engines should not read a novel. */
export const TTS_MAX_CHARS = 5000;
/** One utterance gets at most this long before the process is killed. */
export const TTS_SPEAK_TIMEOUT_MS = 60_000;

export interface TtsSpeakOptions {
  /** Speech rate multiplier (1 = normal). Only honoured where the engine supports it. */
  rate?: number;
  /** BCP-47-ish language tag, e.g. 'vi' or 'en'. Only honoured where the engine supports it. */
  lang?: string;
  /**
   * Engine voice id, e.g. 'vi', 'vi-vn-x-south', 'en' (see
   * `listVoices()`). Takes precedence over `lang` where the engine
   * supports `-v`. Only honoured where the engine supports it.
   */
  voice?: string;
}

/** One voice an engine can speak with (from `listVoices()`). */
export interface TtsVoice {
  /** Id to pass as `TtsSpeakOptions.voice` (e.g. 'vi-vn-x-south'). */
  id: string;
  /** Display name (e.g. 'Vietnamese (Southern)'). */
  name: string;
  /** Language tag of the voice (e.g. 'vi'). */
  lang: string;
}

export interface TtsSpeakResult {
  spoken: boolean;
  /** Engine that spoke (or tried), null when no engine was reached. */
  engineId: string | null;
  /**
   * Machine-readable reason when `spoken` is false:
   * `no-engine-available` | `empty-text` | `timeout` |
   * `engine-spawn-failed` | `engine-exit-<code>` | `stopped`
   * (v0.83: killed by `stop()` or replaced by a newer utterance).
   */
  reason?: string;
}

/** Result of `TtsHarness.stop()` / `TtsEngine.stop()`. */
export interface TtsStopResult {
  /** True when an in-flight utterance was actually killed. */
  stopped: boolean;
  /** Engine that was speaking, null when nothing was speaking. */
  engineId: string | null;
}

export interface TtsEngineStatus {
  id: string;
  name: string;
  kind: 'system' | 'mock';
  available: boolean;
}

export interface TtsEngine {
  readonly id: string;
  readonly name: string;
  readonly kind: 'system' | 'mock';
  isAvailable(): Promise<boolean>;
  speak(text: string, opts?: TtsSpeakOptions): Promise<TtsSpeakResult>;
  /** Voices the engine offers (empty when it cannot list any). */
  listVoices?(lang?: string): Promise<TtsVoice[]>;
  /**
   * Stop the utterance that is still speaking, if any (v0.83).
   * Returns true only when something was actually killed; the
   * in-flight `speak()` promise then resolves `'stopped'`.
   * Engines that cannot stop (or have nothing in flight) return
   * false. Absent = the engine cannot be stopped.
   */
  stop?(): Promise<boolean>;
}

/** A language tag is only passed to an engine when it looks like one. */
const LANG_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

/** A voice id is only passed to an engine when it looks like one. */
const VOICE_RE = /^[A-Za-z0-9][A-Za-z0-9_.+-]*$/;

/** eSpeak's default rate is 175 words/minute; `rate` scales it. */
const ESPEAK_DEFAULT_WPM = 175;
/** Clamp the speaking rate to a range engines accept. */
export function rateToWpm(rate: number | undefined): number {
  const r = typeof rate === 'number' && Number.isFinite(rate) ? rate : 1;
  return Math.min(450, Math.max(80, Math.round(ESPEAK_DEFAULT_WPM * r)));
}

/** spd-say's rate is -100..100 around the default (0 = normal). */
export function rateToSpdSay(rate: number | undefined): number {
  const r = typeof rate === 'number' && Number.isFinite(rate) ? rate : 1;
  return Math.min(100, Math.max(-100, Math.round((r - 1) * 100)));
}

/**
 * Strip Markdown / HTML so a speech engine reads prose, not syntax:
 * code fences and inline code lose their backticks, links keep their
 * text, headings lose their `#`, emphasis markers disappear, HTML
 * tags are dropped, and runs of whitespace collapse to one space.
 */
export function stripMarkdownForSpeech(text: string): string {
  let out = String(text ?? '');
  // Fenced code blocks: drop the code, keep a pause.
  out = out.replace(/```[\s\S]*?```/g, ' ');
  // Images keep their alt text; links keep their text.
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Inline code keeps its content.
  out = out.replace(/`([^`]*)`/g, '$1');
  // Headings, quotes and list markers.
  out = out.replace(/^#{1,6}\s+/gm, '');
  out = out.replace(/^>\s?/gm, '');
  out = out.replace(/^(\s*)([-*+]|\d+[.)])\s+/gm, '$1');
  // Emphasis / strikethrough markers.
  out = out.replace(/(\*\*|__)(.*?)\1/g, '$2');
  out = out.replace(/(\*|_)(.*?)\1/g, '$2');
  out = out.replace(/~~(.*?)~~/g, '$1');
  // HTML tags.
  out = out.replace(/<[^>]*>/g, ' ');
  // Collapse whitespace.
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

/** Find an executable binary by scanning PATH (no subprocess needed). */
function findOnPath(binary: string): string | null {
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    try {
      if (existsSync(candidate)) {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      }
    } catch {
      // Not executable here — keep looking.
    }
  }
  return null;
}

/** One candidate system engine: binary + how to call it. */
interface SystemTtsCandidate {
  id: string;
  name: string;
  binary: string;
  /** argv for the (already cleaned) text. */
  argv(text: string, opts?: TtsSpeakOptions): string[];
}

const SYSTEM_TTS_CANDIDATES: SystemTtsCandidate[] = [
  {
    id: 'espeak-ng',
    name: 'eSpeak NG',
    binary: 'espeak-ng',
    argv: (text, opts) => {
      const args: string[] = [];
      // Voice wins over lang: both are `-v`, and a voice id is the
      // more specific choice (e.g. 'vi-vn-x-south' vs 'vi').
      if (opts?.voice && VOICE_RE.test(opts.voice)) args.push('-v', opts.voice);
      else if (opts?.lang && LANG_RE.test(opts.lang)) args.push('-v', opts.lang);
      if (opts?.rate !== undefined) args.push('-s', String(rateToWpm(opts.rate)));
      args.push(text);
      return args;
    },
  },
  {
    id: 'espeak',
    name: 'eSpeak',
    binary: 'espeak',
    argv: (text, opts) => {
      const args: string[] = [];
      if (opts?.voice && VOICE_RE.test(opts.voice)) args.push('-v', opts.voice);
      else if (opts?.lang && LANG_RE.test(opts.lang)) args.push('-v', opts.lang);
      if (opts?.rate !== undefined) args.push('-s', String(rateToWpm(opts.rate)));
      args.push(text);
      return args;
    },
  },
  {
    id: 'spd-say',
    name: 'Speech Dispatcher',
    binary: 'spd-say',
    // No voice selection on the CLI (voice is a dispatcher setting);
    // lang + rate are honoured.
    argv: (text, opts) => {
      const args: string[] = [];
      if (opts?.lang && LANG_RE.test(opts.lang)) args.push('-l', opts.lang);
      if (opts?.rate !== undefined) args.push('-r', String(rateToSpdSay(opts.rate)));
      args.push(text);
      return args;
    },
  },
  {
    id: 'say',
    name: 'macOS say',
    binary: 'say',
    argv: (text, opts) => {
      const args: string[] = [];
      if (opts?.voice && VOICE_RE.test(opts.voice)) args.push('-v', opts.voice);
      if (opts?.rate !== undefined) args.push('-r', String(rateToWpm(opts.rate)));
      args.push(text);
      return args;
    },
  },
  {
    id: 'flite',
    name: 'Flite',
    binary: 'flite',
    // flite's CLI takes no voice/rate flags — opts are ignored.
    argv: (text) => ['-t', text],
  },
];

/**
 * A speech binary already installed on this machine. Detection scans
 * PATH once and caches the first candidate found (priority order is
 * the list above). `speak()` spawns argv-only (no shell) and kills
 * the process after `TTS_SPEAK_TIMEOUT_MS`.
 */
export class SystemTtsEngine implements TtsEngine {
  readonly kind = 'system' as const;
  readonly id: string;
  readonly name: string;
  private readonly candidate: SystemTtsCandidate | null;
  private readonly binaryPath: string | null;
  /** Child speaking right now (v0.83 — `stop()` kills this one). */
  private activeChild: ChildProcess | null = null;
  /**
   * Children killed by `stop()` / replaced by a newer utterance
   * (v0.83 — per child, not one shared flag: the old child's `close`
   * may fire AFTER the new utterance already reset the active slot,
   * and it must still resolve `'stopped'`).
   */
  private stoppedChildren = new Set<ChildProcess>();

  constructor() {
    let found: SystemTtsCandidate | null = null;
    let foundPath: string | null = null;
    for (const candidate of SYSTEM_TTS_CANDIDATES) {
      const p = findOnPath(candidate.binary);
      if (p) {
        found = candidate;
        foundPath = p;
        break;
      }
    }
    this.candidate = found;
    this.binaryPath = foundPath;
    this.id = found?.id ?? 'system';
    this.name = found?.name ?? 'System speech (none installed)';
  }

  async isAvailable(): Promise<boolean> {
    return this.candidate !== null;
  }

  /**
   * Voices from `espeak-ng --voices[=<lang>]` (eSpeak family only —
   * spd-say/say/flite have no CLI voice list, so they return []).
   * Parses one line per voice: ` 5  vi  --/M  Vietnamese_(Northern)
   * aav/vi` → `{ id: 'vi', name: 'Vietnamese (Northern)', lang: 'vi' }`.
   * Never throws; a slow or failing engine yields [].
   */
  async listVoices(lang?: string): Promise<TtsVoice[]> {
    if (!this.candidate || !this.binaryPath) return [];
    if (this.candidate.id !== 'espeak-ng' && this.candidate.id !== 'espeak') return [];
    const filter =
      lang && (LANG_RE.test(lang) || VOICE_RE.test(lang)) ? [`--voices=${lang}`] : ['--voices'];
    const binaryPath = this.binaryPath;
    return new Promise((resolve) => {
      let settled = false;
      let out = '';
      const finish = (voices: TtsVoice[]): void => {
        if (settled) return;
        settled = true;
        resolve(voices);
      };
      let child;
      try {
        child = spawn(binaryPath, filter, {
          stdio: ['ignore', 'pipe', 'ignore'],
          shell: false,
          windowsHide: true,
        });
      } catch {
        finish([]);
        return;
      }
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
        finish([]);
      }, TTS_LIST_VOICES_TIMEOUT_MS);
      timer.unref?.();
      child.stdout?.on('data', (chunk) => {
        out += String(chunk);
        if (out.length > 1_000_000) {
          try {
            child.kill('SIGKILL');
          } catch {
            // Already gone.
          }
        }
      });
      child.on('error', () => {
        clearTimeout(timer);
        finish([]);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        finish(code === 0 ? parseEspeakVoices(out) : []);
      });
    });
  }

  async speak(text: string, opts?: TtsSpeakOptions): Promise<TtsSpeakResult> {
    if (!this.candidate || !this.binaryPath) {
      return { spoken: false, engineId: this.id, reason: 'no-engine-available' };
    }
    const clean = stripMarkdownForSpeech(text).slice(0, TTS_MAX_CHARS);
    if (!clean) {
      return { spoken: false, engineId: this.id, reason: 'empty-text' };
    }
    const args = this.candidate.argv(clean, opts);
    // A new utterance replaces one still speaking: the old promise
    // resolves 'stopped' (v0.83) instead of two voices overlapping.
    this.killActive();
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let child: ChildProcess | null = null;
      const finish = (result: TtsSpeakResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (child !== null && this.activeChild === child) {
          this.activeChild = null;
        }
        if (child !== null) this.stoppedChildren.delete(child);
        resolve(result);
      };
      try {
        child = spawn(this.binaryPath as string, args, {
          stdio: ['ignore', 'ignore', 'pipe'],
          shell: false,
          windowsHide: true,
        });
      } catch {
        finish({ spoken: false, engineId: this.id, reason: 'engine-spawn-failed' });
        return;
      }
      const speaking: ChildProcess = child;
      this.activeChild = speaking;
      timer = setTimeout(() => {
        try {
          speaking.kill('SIGKILL');
        } catch {
          // Already gone.
        }
        finish({ spoken: false, engineId: this.id, reason: 'timeout' });
      }, TTS_SPEAK_TIMEOUT_MS);
      // Unref the timer so a long utterance does not keep the process alive.
      timer.unref?.();
      speaking.on('error', () => {
        finish({ spoken: false, engineId: this.id, reason: 'engine-spawn-failed' });
      });
      speaking.on('close', (code) => {
        if (this.stoppedChildren.has(speaking)) {
          finish({ spoken: false, engineId: this.id, reason: 'stopped' });
        } else if (code === 0) {
          finish({ spoken: true, engineId: this.id });
        } else {
          finish({ spoken: false, engineId: this.id, reason: `engine-exit-${code ?? 'unknown'}` });
        }
      });
    });
  }

  /**
   * Stop the utterance that is still speaking (v0.83): SIGKILL the
   * active child. The in-flight `speak()` promise then resolves
   * `{ spoken: false, reason: 'stopped' }` via its `close` handler.
   * Returns false when nothing is speaking (or the child already
   * exited — `exitCode` is set). Never throws.
   */
  async stop(): Promise<boolean> {
    const child = this.activeChild;
    if (!child) return false;
    if (child.exitCode !== null || child.signalCode !== null) return false;
    this.stoppedChildren.add(child);
    try {
      child.kill('SIGKILL');
    } catch {
      return false;
    }
    return true;
  }

  /** Mark the active child stopped and SIGKILL it (best-effort). */
  private killActive(): void {
    const child = this.activeChild;
    if (!child) return;
    this.stoppedChildren.add(child);
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone — its close handler still resolves 'stopped'.
    }
  }
}

/** Timeout for listing voices — a slow engine must not block the UI. */
const TTS_LIST_VOICES_TIMEOUT_MS = 5_000;

/**
 * Parse `espeak-ng --voices` output into voices. One line per voice:
 * ` 5  vi  --/M  Vietnamese_(Northern) aav/vi` — Pty, Language,
 * Age/Gender, VoiceName, File. The Language column is the id to pass
 * as `TtsSpeakOptions.voice`; the header line and junk never match.
 * Exported for tests (the spawn path is covered by listVoices tests
 * with a fake binary).
 */
export function parseEspeakVoices(output: string): TtsVoice[] {
  const lineRe = /^\s*\d+\s+(\S+)\s+\S+\s+(\S+)\s+\S+\s*$/;
  const seen = new Set<string>();
  const voices: TtsVoice[] = [];
  for (const line of String(output ?? '').split('\n')) {
    const m = lineRe.exec(line);
    if (!m) continue;
    const [, id, voiceName] = m;
    if (seen.has(id)) continue;
    seen.add(id);
    voices.push({ id, name: voiceName.replace(/_/g, ' '), lang: id.split('-')[0] });
    if (voices.length >= 500) break;
  }
  return voices;
}

/**
 * In-memory engine for tests (and for machines without any engine):
 * records every utterance instead of speaking it.
 */
export class MockTtsEngine implements TtsEngine {
  readonly id = 'mock';
  readonly name = 'Mock (test only)';
  readonly kind = 'mock' as const;
  readonly utterances: Array<{ text: string; opts?: TtsSpeakOptions }> = [];

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async speak(text: string, opts?: TtsSpeakOptions): Promise<TtsSpeakResult> {
    const clean = stripMarkdownForSpeech(text).slice(0, TTS_MAX_CHARS);
    if (!clean) {
      return { spoken: false, engineId: this.id, reason: 'empty-text' };
    }
    this.utterances.push({ text: clean, opts });
    return { spoken: true, engineId: this.id };
  }

  async listVoices(): Promise<TtsVoice[]> {
    return [];
  }

  /**
   * The mock speaks instantly (no in-flight utterance), so there is
   * never anything to stop — always false (v0.83).
   */
  async stop(): Promise<boolean> {
    return false;
  }
}

/**
 * Picks the first available engine and speaks through it. Never
 * throws — every failure is a `{ spoken: false, reason }` result so
 * the UI can say plainly that there is no voice on this machine.
 */
export class TtsHarness {
  private readonly engines: TtsEngine[];

  constructor(engines: TtsEngine[] = [new SystemTtsEngine()]) {
    this.engines = engines;
  }

  /** Probe every engine once; `engineId` is the first available one. */
  async status(): Promise<{
    available: boolean;
    engineId: string | null;
    engines: TtsEngineStatus[];
  }> {
    const engines: TtsEngineStatus[] = [];
    let first: string | null = null;
    for (const engine of this.engines) {
      let available = false;
      try {
        available = await engine.isAvailable();
      } catch {
        available = false;
      }
      engines.push({ id: engine.id, name: engine.name, kind: engine.kind, available });
      if (available && first === null) first = engine.id;
    }
    return { available: first !== null, engineId: first, engines };
  }

  async speak(text: string, opts?: TtsSpeakOptions): Promise<TtsSpeakResult> {
    const clean = stripMarkdownForSpeech(text).slice(0, TTS_MAX_CHARS);
    if (!clean) {
      return { spoken: false, engineId: null, reason: 'empty-text' };
    }
    for (const engine of this.engines) {
      let available = false;
      try {
        available = await engine.isAvailable();
      } catch {
        available = false;
      }
      if (!available) continue;
      try {
        return await engine.speak(clean, opts);
      } catch (e) {
        return {
          spoken: false,
          engineId: engine.id,
          reason: e instanceof Error ? e.message : 'engine-error',
        };
      }
    }
    return { spoken: false, engineId: null, reason: 'no-engine-available' };
  }

  /** Voices of the first available engine that can list any (else []). */
  async listVoices(lang?: string): Promise<TtsVoice[]> {
    for (const engine of this.engines) {
      if (typeof engine.listVoices !== 'function') continue;
      let available = false;
      try {
        available = await engine.isAvailable();
      } catch {
        available = false;
      }
      if (!available) continue;
      try {
        return await engine.listVoices(lang);
      } catch {
        return [];
      }
    }
    return [];
  }

  /**
   * Stop the utterance that is still speaking, if any (v0.83).
   * Asks the first available engine that can stop; the in-flight
   * `speak()` promise then resolves `{ spoken: false, reason:
   * 'stopped' }`. Never throws. `{ stopped: false }` when nothing
   * was speaking (or no engine can stop).
   */
  async stop(): Promise<TtsStopResult> {
    for (const engine of this.engines) {
      if (typeof engine.stop !== 'function') continue;
      let available = false;
      try {
        available = await engine.isAvailable();
      } catch {
        available = false;
      }
      if (!available) continue;
      try {
        const stopped = await engine.stop();
        if (stopped) return { stopped: true, engineId: engine.id };
      } catch {
        // A failing stop must not break the caller — try the next engine.
        continue;
      }
    }
    return { stopped: false, engineId: null };
  }
}
