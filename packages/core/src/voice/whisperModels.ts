/**
 * Local whisper model inventory (v0.98, Đội T5 — voice live).
 *
 * `detectLocalStt()` answers "is there *a* binary + *a* model?"
 * — one pair, first match wins. For the diagnostics view and for
 * choosing the right model, the app needs the full picture: which
 * whisper.cpp models are actually on this machine, how big they
 * are, and which one the engine would pick. This module is that
 * inventory — pure filesystem reads, no downloads, no network:
 *
 *   listLocalWhisperModels() → LocalWhisperModel[]
 *   recommendWhisperModel(models, { preferAccuracy }) → model | null
 *
 * Model sizes are the whisper.cpp ggml sizes (tiny ~75 MB, base
 * ~142 MB, small ~466 MB, medium ~1.5 GB, large ~3 GB); the
 * recommendation is explicit: on a 1.5-CPU VM `tiny` is the only
 * sane default (anything bigger is minutes per utterance), and
 * `preferAccuracy` only steps up when the machine actually has
 * the model *and* enough CPUs to run it (≥4). Nothing here
 * downloads a model — the download command is reported as a
 * string the user (or a setup script) can run.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { WHISPER_MODEL_CANDIDATES } from './localStt';

/** Known whisper.cpp model sizes (approx. MB, ggml). */
export const WHISPER_MODEL_SIZES_MB: Record<string, number> = {
  tiny: 75,
  'tiny.en': 75,
  base: 142,
  'base.en': 142,
  small: 466,
  'small.en': 466,
  medium: 1530,
  'medium.en': 1530,
  large: 3090,
  'large-v1': 3090,
  'large-v2': 3090,
  'large-v3': 3090,
};

/** Download URL pattern for a whisper.cpp ggml model. */
export const WHISPER_MODEL_DOWNLOAD_BASE_URL =
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

/** One whisper model found on this machine. */
export interface LocalWhisperModel {
  /** Model id (e.g. 'tiny', 'tiny.en', 'base'). */
  id: string;
  /** File name (e.g. 'ggml-tiny.bin'). */
  fileName: string;
  /** Absolute path. */
  filePath: string;
  /** File size (bytes). */
  bytes: number;
  /** File size (MB, 1 decimal). */
  sizeMb: number;
  /** English-only model (`.en`) or multilingual. */
  englishOnly: boolean;
  /** True when this is the model `detectLocalStt()` would pick. */
  isDefaultPick: boolean;
}

/** Directories scanned for whisper models. */
export function whisperModelSearchRoots(): string[] {
  const home = process.env.HOME ?? '';
  const roots = [
    process.env.WHISPER_MODEL ? path.dirname(process.env.WHISPER_MODEL) : '',
    path.join(home, '.cache', 'whisper'),
    path.join(home, 'tools', 'whisper.cpp', 'models'),
    path.join(home, 'tools', 'whisper'),
    '/usr/share/whisper',
    '/usr/local/share/whisper',
  ];
  return roots.filter(Boolean);
}

/** Parse a ggml file name into a model id (null when not a ggml model file). */
export function parseWhisperModelFileName(fileName: string): string | null {
  const m = String(fileName ?? '').match(/^ggml-(.+)\.bin$/);
  if (!m) return null;
  return m[1] as string;
}

/**
 * List every whisper model file found in the search roots.
 * Duplicates (same file name in two roots) are reported once —
 * the first root wins. `isDefaultPick` marks the file
 * `WhisperCliSttEngine` would pick first (the earliest
 * `WHISPER_MODEL_CANDIDATES` entry found anywhere).
 */
export function listLocalWhisperModels(
  roots: string[] = whisperModelSearchRoots(),
): LocalWhisperModel[] {
  const found = new Map<string, LocalWhisperModel>();
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const id = parseWhisperModelFileName(entry);
      if (!id || found.has(entry)) continue;
      const filePath = path.join(root, entry);
      let bytes = 0;
      try {
        bytes = statSync(filePath).size;
      } catch {
        continue;
      }
      found.set(entry, {
        id,
        fileName: entry,
        filePath,
        bytes,
        sizeMb: Math.round((bytes / (1024 * 1024)) * 10) / 10,
        englishOnly: id.endsWith('.en'),
        isDefaultPick: false,
      });
    }
  }
  const models = [...found.values()];
  // The default pick is the earliest candidate name present.
  for (const candidate of WHISPER_MODEL_CANDIDATES) {
    const pick = models.find((m) => m.fileName === candidate);
    if (pick) {
      pick.isDefaultPick = true;
      break;
    }
  }
  return models.sort((a, b) => (a.sizeMb - b.sizeMb) || a.id.localeCompare(b.id));
}

/** CPUs available (for the accuracy-vs-speed recommendation). */
export function availableCpuCount(): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cpus = (globalThis as { process?: { availableParallelism?: () => number } }).process
      ?.availableParallelism?.();
    if (typeof cpus === 'number' && cpus > 0) return Math.floor(cpus);
  } catch {
    // Fall through to 1.
  }
  return 1;
}

/**
 * Recommend a model from the inventory. Rules (explicit):
 *   - nothing found → null.
 *   - default (speed): the smallest model — on this VM that is
 *     `tiny`, the only one that transcribes in reasonable time.
 *   - `preferAccuracy: true`: the largest model the machine can
 *     actually run — but only when it has ≥4 CPUs; on fewer CPUs
 *     accuracy still loses to `tiny` (a `small` model on 1.5 CPUs
 *     takes minutes per utterance, which no accuracy gain repays).
 * English-only (`.en`) models are preferred for English, but a
 * multilingual model of the same size wins when the caller wants
 * other languages (`wantLanguages` — e.g. `['vi']`).
 */
export function recommendWhisperModel(
  models: LocalWhisperModel[],
  options: { preferAccuracy?: boolean; wantLanguages?: string[] } = {},
): LocalWhisperModel | null {
  if (models.length === 0) return null;
  const wantsNonEnglish = (options.wantLanguages ?? []).some((l) => l.toLowerCase() !== 'en');
  const pool = wantsNonEnglish ? models.filter((m) => !m.englishOnly) : models;
  const candidates = pool.length > 0 ? pool : models;
  if (options.preferAccuracy && availableCpuCount() >= 4) {
    return [...candidates].sort((a, b) => b.sizeMb - a.sizeMb)[0] ?? null;
  }
  return [...candidates].sort((a, b) => a.sizeMb - b.sizeMb)[0] ?? null;
}

/** Download command for a model id (the user / setup script runs it). */
export function whisperModelDownloadCommand(modelId: string): string {
  const id = String(modelId ?? '').trim() || 'tiny';
  return (
    `cd ~/.cache/whisper && curl -L -o ggml-${id}.bin ` +
    `${WHISPER_MODEL_DOWNLOAD_BASE_URL}/ggml-${id}.bin`
  );
}

/** Expected size (MB) for a model id, or null when unknown. */
export function expectedWhisperModelSizeMb(modelId: string): number | null {
  return WHISPER_MODEL_SIZES_MB[String(modelId ?? '').trim()] ?? null;
}

/** True when the file at `filePath` is a complete model (size within 10% of expected). */
export function isCompleteWhisperModel(filePath: string): boolean {
  try {
    if (!existsSync(filePath)) return false;
    const id = parseWhisperModelFileName(path.basename(filePath));
    if (!id) return false;
    const expected = expectedWhisperModelSizeMb(id);
    if (expected === null) return statSync(filePath).size > 0;
    const actualMb = statSync(filePath).size / (1024 * 1024);
    return actualMb >= expected * 0.9;
  } catch {
    return false;
  }
}
