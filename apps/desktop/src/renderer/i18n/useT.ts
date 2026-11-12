/**
 * React bindings for the i18n module.
 *
 * `useT()` returns the `t()` function for the current locale and re-renders
 * the component when the locale changes. `useLocale()` returns the current
 * locale code (e.g. for a `<select value>`).
 */
import { useCallback, useSyncExternalStore } from 'react';
import { getLocale, subscribeLocale, tFor, type TranslateVars } from './index';

export type TFunction = (key: string, vars?: TranslateVars) => string;

export function useLocale(): string {
  return useSyncExternalStore(subscribeLocale, getLocale);
}

export function useT(): TFunction {
  const locale = useLocale();
  return useCallback((key: string, vars?: TranslateVars) => tFor(locale, key, vars), [locale]);
}
