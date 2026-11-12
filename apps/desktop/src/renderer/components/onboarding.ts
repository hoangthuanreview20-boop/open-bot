/**
 * Onboarding first-run (UI-10, v0.60) — pure helpers, no React.
 *
 * Kept dependency-free (like markdown.ts) so the rules are unit-testable
 * with node --test: when to show the screen, the "done" flag in
 * localStorage, and the one-click sample-bot config.
 *
 * Rules:
 * - Show only when the app has NO bot yet AND the user never finished or
 *   dismissed onboarding. Once the flag is set it never shows again —
 *   not even after the last bot is deleted.
 * - Finishing = creating any bot (sample or own) or pressing "skip".
 * - The sample bot comes from the built-in 'general' template when
 *   available; without templates it is a bare general assistant.
 */
import type { AgentTemplateLike, BotConfigLike } from '../types';

/** localStorage flag: set once the user finished or dismissed onboarding. */
export const ONBOARDING_DONE_KEY = 'open-bot:onboardingDone';

export type OnboardingStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** True when the flag is set. Never throws (storage may be unavailable). */
export function readOnboardingDone(storage: OnboardingStorage | null | undefined): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(ONBOARDING_DONE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Persist the flag. Never throws (storage may be unavailable). */
export function markOnboardingDone(storage: OnboardingStorage | null | undefined): void {
  if (!storage) return;
  try {
    storage.setItem(ONBOARDING_DONE_KEY, '1');
  } catch {
    // Storage unavailable — onboarding just shows again next launch.
  }
}

/**
 * Show the first-run screen only when there is no bot yet and the user
 * never finished/dismissed it. Existing users (botCount > 0) never see
 * it, and neither does anyone who already dismissed it.
 */
export function shouldShowOnboarding(botCount: number, done: boolean): boolean {
  return botCount === 0 && !done;
}

/** Template id of the general-purpose sample bot. */
export const SAMPLE_TEMPLATE_ID = 'general';

/**
 * Pick the template for the sample bot: the 'general' assistant when
 * present, else the first template that is not the triage router (it
 * only routes to specialist bots and is useless alone), else undefined
 * (the caller then falls back to a bare config).
 */
export function pickSampleTemplate(
  templates: AgentTemplateLike[],
): AgentTemplateLike | undefined {
  if (templates.length === 0) return undefined;
  return (
    templates.find((t) => t.id === SAMPLE_TEMPLATE_ID) ??
    templates.find((t) => t.id !== 'triage') ??
    undefined
  );
}

/**
 * Build the createBot config for the one-click sample bot from the
 * picked template (or a bare fallback when no template is available).
 * No workspace is preset — main assigns the bot's default workspace.
 * The bot asks before writes (same default as the create form).
 */
export function buildSampleBotConfig(
  templates: AgentTemplateLike[],
  fallbackName: string,
): Partial<BotConfigLike> {
  const tpl = pickSampleTemplate(templates);
  return {
    name: fallbackName,
    providerId: tpl?.providerId ?? 'xai',
    model: tpl?.model ?? '',
    systemPrompt: tpl?.systemPrompt ?? '',
    approvalLevel: 'ask-for-writes',
  };
}

// ---------------------------------------------------------------------------
// How a bot gets its model (v0.72c, Team C) — keyless paths first.
// ---------------------------------------------------------------------------

/** One way a bot can get a model, shown on the first-run screen. */
export interface OnboardingModelPath {
  /** Stable id (also the i18n key suffix: onboarding.path<Cli|Ollama|Key>*). */
  id: 'cli' | 'ollama' | 'key';
  /** i18n key for the path title (onboarding.pathCliTitle, …). */
  titleKey: string;
  /** i18n key for the one-line explanation (onboarding.pathCliText, …). */
  textKey: string;
  /** True when the path needs an API key of its own. */
  requiresKey: boolean;
}

/**
 * The three ways a bot gets its model, in the order the first-run
 * screen shows them: the two keyless paths first (an AI agent already
 * logged in on this machine, a local model via Ollama), the API-key
 * path last. The order is the point — a new user should see that they
 * can start without a key before anyone asks them for one.
 */
export const ONBOARDING_MODEL_PATHS: OnboardingModelPath[] = [
  {
    id: 'cli',
    titleKey: 'onboarding.pathCliTitle',
    textKey: 'onboarding.pathCliText',
    requiresKey: false,
  },
  {
    id: 'ollama',
    titleKey: 'onboarding.pathOllamaTitle',
    textKey: 'onboarding.pathOllamaText',
    requiresKey: false,
  },
  {
    id: 'key',
    titleKey: 'onboarding.pathKeyTitle',
    textKey: 'onboarding.pathKeyText',
    requiresKey: true,
  },
];

/** Fresh copies of the model paths, keyless paths first. */
export function onboardingModelPaths(): OnboardingModelPath[] {
  return ONBOARDING_MODEL_PATHS.map((p) => ({ ...p }));
}

/** Only the paths that need no API key, in display order. */
export function keylessModelPaths(): OnboardingModelPath[] {
  return onboardingModelPaths().filter((p) => !p.requiresKey);
}
