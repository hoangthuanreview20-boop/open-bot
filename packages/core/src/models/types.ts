/**
 * Model registry — types (v0.5).
 *
 * The ModelRegistry (see registry.ts) is the SINGLE source of truth for
 * model names in open-bot. Clients (renderer, BotForm, templates, the
 * agent loop) must NOT hard-code model names such as 'grok-4.7': they
 * ask the registry for the default / fallback / per-feature model of a
 * provider instead. The built-in catalogue below is only the default;
 * the user can override it from `<userData>/models.json`, which is
 * merged on top — never replacing the built-ins outright, so a bad or
 * partial user file can never leave a provider with no models at all.
 *
 * A "feature" is an open string key ('chat' | 'code' | 'research' |
 * 'voice' | 'vision' | 'long-context' | ...). New features need no
 * code change: they are just new keys. A feature model is stored per
 * provider, so e.g. the 'code' model of xAI and the 'code' model of
 * Ollama are independent choices.
 */

/** One model in a provider's catalogue. `label` defaults to `id`. */
export interface ModelInfo {
  id: string;
  label: string;
}

/**
 * Everything the UI needs for one provider: its catalogue, the model
 * to use when nothing else is chosen, the cheaper model to fall back
 * to when the default fails or is too expensive, and the model chosen
 * for each feature (feature key -> model id, only for features the
 * user explicitly set for this provider).
 */
export interface ProviderModels {
  providerId: string;
  models: ModelInfo[];
  defaultModel: string;
  fallbackModel: string;
  features: Record<string, string>;
}

/** A resolved per-feature choice: which provider, which model. */
export interface FeatureModel {
  providerId: string;
  model: string;
}

/** Per-feature choices, keyed by feature name. */
export type FeatureModelMap = Record<string, FeatureModel>;

/**
 * One provider's section inside the user override file
 * (`<userData>/models.json`). All fields are optional and merged
 * onto the built-in catalogue: `models` are appended (same id
 * replaces the built-in label), `defaultModel` / `fallbackModel`
 * replace the built-in choice when non-empty, `features` are merged
 * per feature key.
 */
export interface UserProviderOverrides {
  models?: Array<{ id: string; label?: string }>;
  defaultModel?: string;
  fallbackModel?: string;
  features?: Record<string, string>;
}

/**
 * Shape of `<userData>/models.json` (the user delta only — built-in
 * models are never written here, see ModelRegistry.save). Unknown
 * provider ids and malformed entries are skipped with a warning,
 * never fatal.
 */
export interface UserModelOverrides {
  providers?: Record<string, UserProviderOverrides>;
  featureFlags?: Record<string, boolean>;
}

/** File name of the user overrides, relative to the app userData dir. */
export const MODELS_FILE = 'models.json';

/**
 * Built-in feature flags. 'voice' ships enabled (voice calls and
 * voice memos landed in v0.4); 'vision' and 'long-context' are
 * opt-in experiments. The user file can flip any of these, and new
 * flags can be added without a release — `getFeatureFlag` returns
 * false for any flag never mentioned anywhere.
 */
export const DEFAULT_FEATURE_FLAGS: Record<string, boolean> = {
  voice: true,
  vision: false,
  'long-context': false,
};

/** Snapshot returned by ModelRegistry.snapshot() (and by IPC 'models:list'). */
export interface ModelRegistrySnapshot {
  providers: Record<string, ProviderModels>;
  featureFlags: Record<string, boolean>;
}
