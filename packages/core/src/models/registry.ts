/**
 * ModelRegistry (v0.5) — the single source of truth for model names.
 *
 * Built-in catalogue per provider = the provider's KNOWN_MODELS plus
 * every model that has a price row in usage/pricing.ts for that
 * provider (so the spend banner and the registry never disagree about
 * which models exist). The 'openai-compatible' provider has no fixed
 * catalogue of its own: its built-in models are the preset default
 * models from presets.ts.
 *
 * User overrides live in `<userData>/models.json` (MODELS_FILE) and
 * are merged on top of the built-ins:
 *
 *   {
 *     "providers": {
 *       "xai": {
 *         "models": [{ "id": "grok-4.7-custom", "label": "Grok tuỳ chỉnh" }],
 *         "defaultModel": "grok-4.7",
 *         "fallbackModel": "grok-4.1-fast",
 *         "features": { "code": "grok-4.7", "research": "grok-4.6" }
 *       }
 *     },
 *     "featureFlags": { "vision": true }
 *   }
 *
 * Merge rules: user models append (same id replaces the built-in
 * label, never duplicates); user default/fallback replace the
 * built-in choice when non-empty; user features merge per key;
 * user flags merge (user wins). A missing file means built-ins only.
 * A corrupt file, or a corrupt entry inside it, is logged via the
 * `logger.warn` hook and skipped — the registry keeps working on
 * built-ins and never throws from load().
 *
 * Persistence is deliberately two-step: setters only change memory
 * (and the in-memory merged view); call save() to write the user
 * delta back to disk. save() writes ONLY the user overrides, never
 * the built-in catalogue, so a future app update can change
 * built-ins without fighting the user's file.
 *
 * Registry là nguồn duy nhất cho tên model — client không hard-code
 * tên model nữa: BotForm, templates, the default bot and the agent
 * loop must ask this registry (getDefault / getFallback /
 * getModelForFeature) instead of writing e.g. 'grok-4.7' inline.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { PROVIDERS } from '../providers/index';
import { ANTHROPIC_KNOWN_MODELS } from '../providers/anthropic';
import { COHERE_KNOWN_MODELS } from '../providers/cohere';
import { DEEPSEEK_KNOWN_MODELS } from '../providers/deepseek';
import { GEMINI_KNOWN_MODELS, GEMINI_PREVIEW_MODELS } from '../providers/gemini';
import { GROQ_KNOWN_MODELS } from '../providers/groq';
import { MISTRAL_KNOWN_MODELS } from '../providers/mistral';
import { MOONSHOT_KNOWN_MODELS } from '../providers/moonshot';
import { OLLAMA_KNOWN_MODELS } from '../providers/ollama';
import { OPENAI_KNOWN_MODELS } from '../providers/openai';
import { QWEN_KNOWN_MODELS } from '../providers/qwen';
import { TOGETHER_KNOWN_MODELS } from '../providers/together';
import { XAI_KNOWN_MODELS } from '../providers/xai';
import { listPricedModels } from '../usage/pricing';
import { COMPATIBLE_PRESETS } from './presets';
import {
  DEFAULT_FEATURE_FLAGS,
  MODELS_FILE,
  type FeatureModel,
  type ModelInfo,
  type ModelRegistrySnapshot,
  type ProviderModels,
  type UserModelOverrides,
  type UserProviderOverrides,
} from './types';

export { MODELS_FILE };
export type {
  FeatureModel,
  ModelInfo,
  ModelRegistrySnapshot,
  ProviderModels,
  UserModelOverrides,
  UserProviderOverrides,
} from './types';
export { DEFAULT_FEATURE_FLAGS } from './types';

export interface ModelRegistryOptions {
  /** Path of the user overrides file, e.g. `<userData>/models.json`. */
  filePath?: string;
  /** Where warnings go; defaults to console.warn. */
  logger?: { warn(message: string): void };
}

/** Priced-model prefix -> provider id (from usage/pricing.ts ids). */
const PRICED_PREFIX_PROVIDER: Array<[string, string]> = [
  ['grok-', 'xai'],
  ['gpt-', 'openai'],
  ['claude-', 'anthropic'],
  ['gemini-', 'gemini'],
];

function providerIdForPricedModel(modelId: string): string | undefined {
  for (const [prefix, providerId] of PRICED_PREFIX_PROVIDER) {
    if (modelId.startsWith(prefix)) return providerId;
  }
  return undefined;
}

/** Cheaper model used when a provider's default fails or costs too much. */
const BUILTIN_FALLBACKS: Record<string, string> = {
  xai: 'grok-4.1-fast',
  openai: 'gpt-5-nano',
  anthropic: 'claude-haiku-4-5',
  gemini: 'gemini-2.5-flash-lite',
  // v0.97 (Team T6): cheaper fallback per new API provider (the
  // default model when no cheaper distinct model exists).
  deepseek: 'deepseek-v4-flash',
  moonshot: 'kimi-k2.6',
  qwen: 'qwen-plus',
  mistral: 'mistral-small-latest',
  groq: 'llama-3.1-8b-instant',
  together: 'meta-llama/Llama-3.1-8B-Instruct-Turbo',
  cohere: 'command-r-08-2024',
  ollama: 'qwen2.5',
  'openai-compatible': '',
  // M1: CLI provider chỉ có một model — fallback là chính nó.
  'claude-code': 'claude-code',
  // M2: CLI provider Codex / Grok — cũng chỉ một model mỗi provider.
  codex: 'codex',
  'grok-cli': 'grok-cli',
  // M3: CLI provider OpenCode / Gemini CLI / Cursor CLI / Custom ACP —
  // cũng chỉ một model mỗi provider (custom-acp: model là slug).
  opencode: 'opencode',
  'gemini-cli': 'gemini-cli',
  'cursor-cli': 'cursor-cli',
  'custom-acp': 'custom-acp',
  // M4 (sóng B): CLI provider Aider / Continue / Amazon Q / Copilot /
  // Windsurf — cũng chỉ một model mỗi provider.
  aider: 'aider',
  'continue-cli': 'continue-cli',
  'amazon-q': 'amazon-q',
  'copilot-cli': 'copilot-cli',
  windsurf: 'windsurf',
};

const KNOWN_MODELS_BY_PROVIDER: Record<string, readonly string[]> = {
  openai: OPENAI_KNOWN_MODELS,
  anthropic: ANTHROPIC_KNOWN_MODELS,
  gemini: GEMINI_KNOWN_MODELS,
  xai: XAI_KNOWN_MODELS,
  // v0.97 (Team T6): dedicated OpenAI-compatible API providers.
  deepseek: DEEPSEEK_KNOWN_MODELS,
  moonshot: MOONSHOT_KNOWN_MODELS,
  qwen: QWEN_KNOWN_MODELS,
  mistral: MISTRAL_KNOWN_MODELS,
  groq: GROQ_KNOWN_MODELS,
  together: TOGETHER_KNOWN_MODELS,
  cohere: COHERE_KNOWN_MODELS,
  ollama: [...OLLAMA_KNOWN_MODELS, 'qwen2.5:0.5b'],
  'openai-compatible': COMPATIBLE_PRESETS.map((p) => p.defaultModel),
  // M1: model duy nhất của CLI provider — model thật do CLI đã đăng nhập quyết định.
  'claude-code': ['claude-code'],
  // M2: tương tự cho Codex và Grok CLI.
  codex: ['codex'],
  'grok-cli': ['grok-cli'],
  // M3: tương tự cho OpenCode, Gemini CLI, Cursor CLI; custom-acp có
  // model là slug của CLI tuỳ chỉnh (placeholder khi chưa chọn).
  opencode: ['opencode'],
  'gemini-cli': ['gemini-cli'],
  'cursor-cli': ['cursor-cli'],
  'custom-acp': ['custom-acp'],
  // M4 (sóng B): tương tự cho Aider, Continue, Amazon Q, Copilot CLI,
  // Windsurf.
  aider: ['aider'],
  'continue-cli': ['continue-cli'],
  'amazon-q': ['amazon-q'],
  'copilot-cli': ['copilot-cli'],
  windsurf: ['windsurf'],
};

/** Built-in catalogue, before any user override is applied. */
function buildBuiltinCatalogue(): Map<string, ProviderModels> {
  const pricedByProvider = new Map<string, string[]>();
  for (const modelId of listPricedModels()) {
    const providerId = providerIdForPricedModel(modelId);
    if (!providerId) continue;
    const list = pricedByProvider.get(providerId) ?? [];
    list.push(modelId);
    pricedByProvider.set(providerId, list);
  }

  const catalogue = new Map<string, ProviderModels>();
  for (const meta of PROVIDERS) {
    const seen = new Set<string>();
    const models: ModelInfo[] = [];
    const add = (id: string, label?: string) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      models.push({ id, label: label ?? id });
    };
    for (const id of KNOWN_MODELS_BY_PROVIDER[meta.id] ?? []) {
      // Model Gemini preview (docs/live-test-gemini.md) được gắn nhãn
      // "(preview)" trong picker; các provider khác giữ label = id.
      const label =
        meta.id === 'gemini' && (GEMINI_PREVIEW_MODELS as readonly string[]).includes(id)
          ? `${id} (preview)`
          : undefined;
      add(id, label);
    }
    for (const id of pricedByProvider.get(meta.id) ?? []) add(id);
    if (meta.id === 'openai-compatible') {
      // Preset models get a label that says which preset they came from.
      for (const preset of COMPATIBLE_PRESETS) {
        const entry = models.find((m) => m.id === preset.defaultModel);
        if (entry) entry.label = `${preset.defaultModel} (${preset.label})`;
      }
    }
    if (meta.id === 'ollama') {
      const local = models.find((m) => m.id === 'qwen2.5:0.5b');
      if (local) local.label = 'qwen2.5:0.5b (local)';
    }
    catalogue.set(meta.id, {
      providerId: meta.id,
      models,
      defaultModel: meta.defaultModel,
      fallbackModel: BUILTIN_FALLBACKS[meta.id] ?? meta.defaultModel,
      features: {},
    });
  }
  return catalogue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate a parsed models.json into a sanitized UserModelOverrides.
 * Every bad entry is skipped with a warning through `warn`; a fully
 * invalid file yields empty overrides (built-ins only), never a throw.
 */
function parseUserOverrides(raw: unknown, warn: (message: string) => void): UserModelOverrides {
  const overrides: UserModelOverrides = {};
  if (!isRecord(raw)) {
    warn(`models.json: nội dung phải là object JSON, đã bỏ qua toàn bộ file.`);
    return overrides;
  }
  const knownProviders = new Set(PROVIDERS.map((p) => p.id));

  if (raw['providers'] !== undefined) {
    if (!isRecord(raw['providers'])) {
      warn(`models.json: "providers" phải là object, đã bỏ qua.`);
    } else {
      const providers: Record<string, UserProviderOverrides> = {};
      for (const [providerId, entry] of Object.entries(raw['providers'])) {
        if (!knownProviders.has(providerId)) {
          warn(`models.json: bỏ qua provider không rõ "${providerId}".`);
          continue;
        }
        if (!isRecord(entry)) {
          warn(`models.json: bỏ qua mục provider "${providerId}" không phải object.`);
          continue;
        }
        const clean: UserProviderOverrides = {};
        if (entry['models'] !== undefined) {
          if (!Array.isArray(entry['models'])) {
            warn(`models.json: "providers.${providerId}.models" phải là mảng, đã bỏ qua.`);
          } else {
            const models: Array<{ id: string; label?: string }> = [];
            for (const m of entry['models']) {
              if (!isRecord(m) || !isNonEmptyString(m['id'])) {
                warn(`models.json: bỏ qua model không hợp lệ của provider "${providerId}".`);
                continue;
              }
              models.push(
                isNonEmptyString(m['label'])
                  ? { id: m['id'], label: m['label'] }
                  : { id: m['id'] },
              );
            }
            if (models.length > 0) clean.models = models;
          }
        }
        if (entry['defaultModel'] !== undefined) {
          if (isNonEmptyString(entry['defaultModel'])) clean.defaultModel = entry['defaultModel'];
          else warn(`models.json: "providers.${providerId}.defaultModel" phải là chuỗi không rỗng, đã bỏ qua.`);
        }
        if (entry['fallbackModel'] !== undefined) {
          if (isNonEmptyString(entry['fallbackModel'])) clean.fallbackModel = entry['fallbackModel'];
          else warn(`models.json: "providers.${providerId}.fallbackModel" phải là chuỗi không rỗng, đã bỏ qua.`);
        }
        if (entry['features'] !== undefined) {
          if (!isRecord(entry['features'])) {
            warn(`models.json: "providers.${providerId}.features" phải là object, đã bỏ qua.`);
          } else {
            const features: Record<string, string> = {};
            for (const [feature, model] of Object.entries(entry['features'])) {
              if (isNonEmptyString(model)) features[feature] = model;
              else warn(`models.json: bỏ qua feature "${feature}" của provider "${providerId}" (model rỗng).`);
            }
            if (Object.keys(features).length > 0) clean.features = features;
          }
        }
        if (Object.keys(clean).length > 0) providers[providerId] = clean;
      }
      if (Object.keys(providers).length > 0) overrides.providers = providers;
    }
  }

  if (raw['featureFlags'] !== undefined) {
    if (!isRecord(raw['featureFlags'])) {
      warn(`models.json: "featureFlags" phải là object, đã bỏ qua.`);
    } else {
      const flags: Record<string, boolean> = {};
      for (const [name, value] of Object.entries(raw['featureFlags'])) {
        if (typeof value === 'boolean') flags[name] = value;
        else warn(`models.json: bỏ qua feature flag "${name}" (phải là true/false).`);
      }
      if (Object.keys(flags).length > 0) overrides.featureFlags = flags;
    }
  }
  return overrides;
}

export class ModelRegistry {
  private readonly filePath?: string;
  private readonly warn: (message: string) => void;
  private overrides: UserModelOverrides = {};
  private providers = new Map<string, ProviderModels>();
  private featureFlags: Record<string, boolean> = { ...DEFAULT_FEATURE_FLAGS };
  /**
   * B-platform M3: model phát hiện được (vd model local Ollama đã pull),
   * chỉ sống TRONG BỘ NHỚ — không bao giờ ghi vào models.json
   * (save() chỉ ghi `overrides`). `load()` không xoá discovered.
   */
  private discovered: Map<string, ModelInfo[]> = new Map();

  constructor(options: ModelRegistryOptions = {}) {
    this.filePath = options.filePath;
    this.warn = options.logger
      ? (message: string) => options.logger?.warn(message)
      : (message: string) => console.warn(`[ModelRegistry] ${message}`);
    this.rebuild();
  }

  /** Path of the user overrides file, if one was configured. */
  get modelsFilePath(): string | undefined {
    return this.filePath;
  }

  // ------------------------------------------------------------------
  // Persistence
  // ------------------------------------------------------------------

  /**
   * (Re)read the user overrides file and rebuild the merged view.
   * Missing file -> built-ins only. Corrupt JSON or corrupt entries
   * -> warn and keep the usable part (or built-ins only). Never throws
   * for file content; only a missing filePath is a no-op here.
   */
  load(): void {
    if (!this.filePath) {
      this.overrides = {};
      this.rebuild();
      return;
    }
    if (!fs.existsSync(this.filePath)) {
      this.overrides = {};
      this.rebuild();
      return;
    }
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      this.warn(`không đọc được ${MODELS_FILE}: ${(err as Error).message}; dùng catalogue mặc định.`);
      this.overrides = {};
      this.rebuild();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (err) {
      this.warn(
        `${MODELS_FILE} hỏng (không phải JSON hợp lệ): ${(err as Error).message}; dùng catalogue mặc định.`,
      );
      this.overrides = {};
      this.rebuild();
      return;
    }
    this.overrides = parseUserOverrides(parsed, this.warn);
    this.rebuild();
  }

  /**
   * Write the user overrides (the delta only) back to the file.
   * Built-in models are never written. Throws when no filePath was
   * configured. Callers should call save() after a setter, e.g. in
   * the IPC handler for 'models:set-feature'.
   */
  save(): void {
    if (!this.filePath) {
      throw new Error('ModelRegistry.save: chưa cấu hình filePath cho models.json.');
    }
    const payload: UserModelOverrides = {};
    if (this.overrides.providers && Object.keys(this.overrides.providers).length > 0) {
      payload.providers = this.overrides.providers;
    }
    if (this.overrides.featureFlags && Object.keys(this.overrides.featureFlags).length > 0) {
      payload.featureFlags = this.overrides.featureFlags;
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  /** Rebuild the merged provider view + flags from built-ins + overrides. */
  private rebuild(): void {
    const merged = buildBuiltinCatalogue();
    const providers = this.overrides.providers ?? {};
    for (const [providerId, entry] of Object.entries(providers)) {
      const target = merged.get(providerId);
      if (!target) continue; // unknown provider ids were already filtered at parse
      if (entry.models) {
        for (const m of entry.models) {
          const existing = target.models.find((x) => x.id === m.id);
          if (existing) {
            if (m.label) existing.label = m.label;
          } else {
            target.models.push({ id: m.id, label: m.label ?? m.id });
          }
        }
      }
      if (entry.defaultModel) target.defaultModel = entry.defaultModel;
      if (entry.fallbackModel) target.fallbackModel = entry.fallbackModel;
      if (entry.features) Object.assign(target.features, entry.features);
    }
    // B-platform M3: model phát hiện được gộp sau overrides — model đã
    // pull thật thì nhãn "(local)" thắng nhãn cũ (vd 'qwen2.5' biết trước
    // nay đã có trên máy), model mới thì thêm vào cuối danh sách.
    for (const [providerId, models] of this.discovered) {
      const target = merged.get(providerId);
      if (!target) continue;
      for (const m of models) {
        const existing = target.models.find((x) => x.id === m.id);
        if (existing) {
          existing.label = `${m.id} (local)`;
        } else {
          target.models.push({ ...m });
        }
      }
    }
    this.providers = merged;
    this.featureFlags = { ...DEFAULT_FEATURE_FLAGS, ...(this.overrides.featureFlags ?? {}) };
  }

  // ------------------------------------------------------------------
  // Discovered models — B-platform M3 (in-memory only, never persisted)
  // ------------------------------------------------------------------

  /**
   * Gộp model phát hiện được (vd model local Ollama đã pull) vào
   * catalogue TRONG BỘ NHỚ, nhãn "(local)". Gọi lại với danh sách mới
   * sẽ THAY THẾ danh sách cũ (không cộng dồn) — main gọi lại mỗi lần
   * refresh danh sách Ollama. Không ghi vào models.json: save() chỉ
   * ghi `overrides`, và `load()` không xoá discovered. Provider không
   * có trong catalogue → throw.
   */
  setDiscoveredModels(providerId: string, modelIds: string[]): void {
    if (!this.providers.has(providerId)) {
      throw new Error(`ModelRegistry.setDiscoveredModels: provider không rõ "${providerId}".`);
    }
    const cleaned = [...new Set(modelIds.map((m) => m.trim()).filter((m) => m.length > 0))];
    this.discovered.set(
      providerId,
      cleaned.map((id) => ({ id, label: `${id} (local)` })),
    );
    this.rebuild();
  }

  // ------------------------------------------------------------------
  // Catalogue reads — the only way clients should learn model names.
  // ------------------------------------------------------------------

  /** Provider ids known to the registry, in PROVIDERS order. */
  listProviderIds(): string[] {
    return [...this.providers.keys()];
  }

  /** Catalogue of one provider, as [{ id, label }]. Throws on unknown provider. */
  listModels(providerId: string): ModelInfo[] {
    return this.requireProvider(providerId).models.map((m) => ({ ...m }));
  }

  /** Default model of a provider ('' for openai-compatible until a preset is picked). */
  getDefault(providerId: string): string {
    return this.requireProvider(providerId).defaultModel;
  }

  /** Fallback model of a provider; the default when no fallback was set. */
  getFallback(providerId: string): string {
    const entry = this.requireProvider(providerId);
    return entry.fallbackModel || entry.defaultModel;
  }

  /** Explicit per-feature model of one provider, or undefined when not set. */
  getFeatureModel(feature: string, providerId: string): string | undefined {
    return this.requireProvider(providerId).features[feature];
  }

  /**
   * Resolve the model for a feature.
   * With `providerId`: that provider's feature model, or its default
   * when the feature was never set for it. Without one: the first
   * provider (in registry order) that has an explicit model for the
   * feature, otherwise the first provider's default model. Never
   * returns an empty model when any provider has a default.
   */
  getModelForFeature(feature: string, providerId?: string): FeatureModel {
    if (!isNonEmptyString(feature)) throw new Error('getModelForFeature cần tên feature không rỗng.');
    if (providerId !== undefined) {
      const entry = this.requireProvider(providerId);
      return { providerId, model: entry.features[feature] ?? entry.defaultModel };
    }
    for (const entry of this.providers.values()) {
      const model = entry.features[feature];
      if (model) return { providerId: entry.providerId, model };
    }
    for (const entry of this.providers.values()) {
      if (entry.defaultModel) return { providerId: entry.providerId, model: entry.defaultModel };
    }
    throw new Error('ModelRegistry: không có provider nào có model mặc định.');
  }

  // ------------------------------------------------------------------
  // Catalogue writes — update the user overrides (call save() to persist).
  // ------------------------------------------------------------------

  private requireProvider(providerId: string): ProviderModels {
    const entry = this.providers.get(providerId);
    if (!entry) throw new Error(`ModelRegistry: không rõ provider id: ${providerId}`);
    return entry;
  }

  private providerOverrides(providerId: string): UserProviderOverrides {
    if (!this.overrides.providers) this.overrides.providers = {};
    const entry = this.overrides.providers[providerId] ?? {};
    this.overrides.providers[providerId] = entry;
    return entry;
  }

  /** Register a model id in a provider's user list when it is not in the catalogue yet. */
  private ensureModelListed(providerId: string, model: string): void {
    const entry = this.requireProvider(providerId);
    if (entry.models.some((m) => m.id === model)) return;
    this.providerOverrides(providerId).models = [
      ...(this.providerOverrides(providerId).models ?? []),
      { id: model },
    ];
  }

  /** Set a provider's default model (unknown ids are added to its user list). */
  setDefault(providerId: string, model: string): void {
    if (!isNonEmptyString(model)) throw new Error('setDefault cần tên model không rỗng.');
    this.requireProvider(providerId);
    this.ensureModelListed(providerId, model);
    this.providerOverrides(providerId).defaultModel = model;
    this.rebuild();
  }

  /** Set a provider's fallback model (unknown ids are added to its user list). */
  setFallback(providerId: string, model: string): void {
    if (!isNonEmptyString(model)) throw new Error('setFallback cần tên model không rỗng.');
    this.requireProvider(providerId);
    this.ensureModelListed(providerId, model);
    this.providerOverrides(providerId).fallbackModel = model;
    this.rebuild();
  }

  /**
   * Set the model a feature uses on a provider. Unknown model ids
   * are added to that provider's user list (local Ollama models
   * pulled later are a normal case — they are not in the built-in
   * catalogue). Call save() to persist.
   */
  setFeatureModel(feature: string, providerId: string, model: string): void {
    if (!isNonEmptyString(feature)) throw new Error('setFeatureModel cần tên feature không rỗng.');
    if (!isNonEmptyString(model)) throw new Error('setFeatureModel cần tên model không rỗng.');
    this.requireProvider(providerId);
    this.ensureModelListed(providerId, model);
    const entry = this.providerOverrides(providerId);
    if (!entry.features) entry.features = {};
    entry.features[feature] = model;
    this.rebuild();
  }

  // ------------------------------------------------------------------
  // Feature flags
  // ------------------------------------------------------------------

  /** True when the flag is enabled; unknown flags default to false. */
  getFeatureFlag(name: string): boolean {
    return this.featureFlags[name] ?? false;
  }

  /** Alias of getFeatureFlag. */
  isFeatureEnabled(name: string): boolean {
    return this.getFeatureFlag(name);
  }

  /** Enable/disable a feature flag (call save() to persist). */
  setFeatureFlag(name: string, enabled: boolean): void {
    if (!isNonEmptyString(name)) throw new Error('setFeatureFlag cần tên flag không rỗng.');
    if (typeof enabled !== 'boolean') throw new Error('setFeatureFlag cần enabled là boolean.');
    if (!this.overrides.featureFlags) this.overrides.featureFlags = {};
    this.overrides.featureFlags[name] = enabled;
    this.rebuild();
  }

  /** Copy of all effective flags (built-in defaults + user overrides). */
  getFeatureFlags(): Record<string, boolean> {
    return { ...this.featureFlags };
  }

  // ------------------------------------------------------------------
  // Snapshot (IPC 'models:list' shape)
  // ------------------------------------------------------------------

  /** Deep copy of the whole merged view, safe to send over IPC. */
  snapshot(): ModelRegistrySnapshot {
    const providers: Record<string, ProviderModels> = {};
    for (const [id, entry] of this.providers) {
      providers[id] = {
        providerId: id,
        models: entry.models.map((m) => ({ ...m })),
        defaultModel: entry.defaultModel,
        fallbackModel: entry.fallbackModel,
        features: { ...entry.features },
      };
    }
    return { providers, featureFlags: this.getFeatureFlags() };
  }
}
