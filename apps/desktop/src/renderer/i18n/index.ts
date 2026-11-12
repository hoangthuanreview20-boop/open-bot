/**
 * Open Bot — i18n (renderer).
 *
 * Tiny dependency-free translator: flat `section.key` strings, one JSON file
 * per language, no new npm packages.
 *
 * To add a language:
 *   1. add `locales/<code>.json` with the same keys as `en.json`,
 *   2. add one entry to LOCALES below (and one import + one DICTS entry).
 * Nothing else needs to change.
 *
 * Lookup order for a key: current locale -> fallback locale ('en') -> the
 * key itself. A missing key never crashes and never renders `undefined`.
 */
import vi from './locales/vi.json' with { type: 'json' };
import en from './locales/en.json' with { type: 'json' };
import zh from './locales/zh.json' with { type: 'json' };
import ja from './locales/ja.json' with { type: 'json' };
import es from './locales/es.json' with { type: 'json' };
import fr from './locales/fr.json' with { type: 'json' };

export type Dict = Record<string, string>;
export type Dictionaries = Record<string, Dict>;
export type TranslateVars = Record<string, string | number>;

export interface LocaleInfo {
  /** BCP 47-ish code, also the locale file name (`locales/<code>.json`). */
  code: string;
  /** Native name shown in the language picker (a proper name, not translated). */
  label: string;
}

export const LOCALES: LocaleInfo[] = [
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'en', label: 'English' },
  { code: 'zh', label: '中文' },
  { code: 'ja', label: '日本語' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
];

/** Language used when nothing is saved yet (and for unknown codes). */
export const DEFAULT_LOCALE = 'vi';
/** Second lookup step when the current locale lacks a key. */
export const FALLBACK_LOCALE = 'en';

const DICTS: Dictionaries = { vi, en, zh, ja, es, fr };

export function isLocale(code: string): boolean {
  return LOCALES.some((l) => l.code === code);
}

/** Map any stored/unknown code to a supported locale (default 'vi'). */
export function normalizeLocale(code: string | null | undefined): string {
  return code && isLocale(code) ? code : DEFAULT_LOCALE;
}

// ---------------------------------------------------------------------------
// Current locale (module-level, observable so React can re-render on change)
// ---------------------------------------------------------------------------

let currentLocale: string = DEFAULT_LOCALE;
const listeners = new Set<() => void>();

export function getLocale(): string {
  return currentLocale;
}

export function setLocale(code: string): string {
  const next = normalizeLocale(code);
  if (next === currentLocale) return currentLocale;
  currentLocale = next;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = next;
  }
  for (const listener of listeners) listener();
  return currentLocale;
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

const PLACEHOLDER = /\{(\w+)\}/g;

export function interpolate(template: string, vars?: TranslateVars): string {
  if (!vars) return template;
  return template.replace(PLACEHOLDER, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/**
 * Pure lookup over an explicit dictionary set — the fallback chain lives
 * here so it can be unit-tested without touching global locale state:
 * `dicts[locale][key]` -> `dicts[FALLBACK_LOCALE][key]` -> `key`.
 */
export function lookup(
  dicts: Dictionaries,
  locale: string,
  key: string,
  vars?: TranslateVars,
): string {
  const primary = dicts[locale] ?? dicts[DEFAULT_LOCALE];
  const value = primary?.[key] ?? dicts[FALLBACK_LOCALE]?.[key] ?? key;
  return interpolate(value, vars);
}

/** Translate a key in the given locale (no global state touched). */
export function tFor(locale: string, key: string, vars?: TranslateVars): string {
  return lookup(DICTS, normalizeLocale(locale), key, vars);
}

/** Translate a key in the current locale. */
export function t(key: string, vars?: TranslateVars): string {
  return lookup(DICTS, currentLocale, key, vars);
}
