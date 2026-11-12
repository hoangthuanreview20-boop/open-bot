# v0.5 worker 1 — Đặc tả tích hợp: Model Registry + Provider Presets + Model Local

> Tài liệu này dành cho người tích hợp (integrator) nối phần core đã xong
> vào app desktop. **Core đã xong, chưa nối UI.** Mọi code mẫu dưới đây
> viết mới theo kiến trúc hiện có; không sao chép code/text/tài sản của
> xAI/Cursor. Tên channel IPC dưới đây là cố định — **không đổi tên**.

## 1. Phần core đã xong (worker 1, không cần sửa lại)

| File | Nội dung |
|---|---|
| `packages/core/src/models/types.ts` | `ModelInfo`, `ProviderModels`, `FeatureModel`, `UserModelOverrides`, `ModelRegistrySnapshot`, `MODELS_FILE` (`'models.json'`), `DEFAULT_FEATURE_FLAGS` (`voice: true`, `vision: false`, `long-context: false`). Ghi rõ: registry là nguồn duy nhất cho tên model. |
| `packages/core/src/models/presets.ts` | `CompatiblePreset`, `COMPATIBLE_PRESETS` (6 preset), `listCompatiblePresets()`, `resolvePreset(id)`. |
| `packages/core/src/models/registry.ts` | `ModelRegistry`: catalogue built-in theo provider (KNOWN_MODELS + model có giá trong `usage/pricing.ts`; `openai-compatible` lấy model mặc định của 6 preset), merge ghi đè user từ `<userData>/models.json` (file hỏng/mục hỏng → warn qua `logger`, dùng built-in, không crash), `save()` chỉ ghi delta của user. |
| `packages/core/src/models/index.ts` | Public surface của `models/`. |
| `packages/core/src/providers/index.ts` | `ProviderMeta` thêm field `presets?: CompatiblePreset[]`; entry `openai-compatible` mang đủ 6 preset; re-export `COMPATIBLE_PRESETS`, `listCompatiblePresets`, `resolvePreset`, type `CompatiblePreset`. |
| `packages/core/src/providers/ollama.ts` | `OllamaProvider.listLocalModels(): Promise<string[]>` (GET `/api/tags`, lỗi/không chạy → `[]`, không fallback sang known list) và `pullModel(model): Promise<void>` (POST `/api/pull` `{name, stream:true}`, đọc NDJSON progress rồi bỏ, throw khi HTTP lỗi hoặc dòng NDJSON báo `status: 'error'` / field `error`). `listModels()` đã refactor để dùng lại `listLocalModels()` cho bước `/api/tags`, không code trùng. |
| `tests/models.test.mjs` | 13 test (xem mục 6). |

### API ModelRegistry (đầy đủ)

```ts
new ModelRegistry({ filePath?: string; logger?: { warn(msg: string): void } })
registry.load(): void            // đọc models.json; thiếu file = built-in; hỏng = warn + built-in
registry.save(): void            // ghi delta user; throw khi chưa cấu hình filePath
registry.listModels(providerId): ModelInfo[]            // [{ id, label }]; throw khi provider lạ
registry.getDefault(providerId): string                 // '' với openai-compatible khi chưa chọn preset
registry.getFallback(providerId): string                // = default khi chưa đặt fallback
registry.setDefault(providerId, model): void            // model lạ tự thêm vào list user
registry.setFallback(providerId, model): void
registry.getModelForFeature(feature, providerId?): { providerId, model }
  // có providerId: feature model của provider đó, chưa đặt thì default của nó
  // không providerId: provider đầu tiên (theo thứ tự PROVIDERS) có model cho
  //   feature đó, nếu không có thì default của provider đầu tiên (openai/gpt-5-mini)
registry.getFeatureModel(feature, providerId): string | undefined
registry.setFeatureModel(feature, providerId, model): void
registry.getFeatureFlag(name): boolean                  // flag lạ mặc định false
registry.setFeatureFlag(name, enabled: boolean): void
registry.isFeatureEnabled(name): boolean                // alias getFeatureFlag
registry.getFeatureFlags(): Record<string, boolean>
registry.listProviderIds(): string[]
registry.snapshot(): ModelRegistrySnapshot
  // { providers: Record<providerId, { providerId, models, defaultModel,
  //     fallbackModel, features: Record<feature, modelId> }>, featureFlags }
```

**Quy ước quan trọng:** setter chỉ đổi bộ nhớ — handler IPC phải gọi
`save()` sau setter (xem mục 3). `save()` không bao giờ ghi model
built-in; file `models.json` chỉ chứa delta của user.

**Catalogue built-in (để UI khỏi hard-code):**

| Provider | Default | Fallback | Catalogue gồm |
|---|---|---|---|
| `xai` | `grok-4.7` | `grok-4.1-fast` | KNOWN + grok có giá: grok-4.7/4.6/4.5/4.3/4/4.1-fast, grok-build-0.1, grok-3 |
| `openai` | `gpt-5-mini` | `gpt-5-nano` | KNOWN + gpt có giá: gpt-5/5-mini/5-nano/5.5/5.4/4o/4o-mini, gpt-4.1/4.1-mini |
| `anthropic` | `claude-sonnet-4-5` | `claude-haiku-4-5` | KNOWN + claude có giá (cả dạng `claude-sonnet-4.5` và `claude-sonnet-4-5`) |
| `gemini` | `gemini-2.5-flash` | `gemini-2.5-flash-lite` | KNOWN + gemini có giá |
| `ollama` | `llama3.1` | `qwen2.5` | KNOWN + `qwen2.5:0.5b` (model local đang có trên máy dev) |
| `openai-compatible` | `''` | `''` | model mặc định của 6 preset (label dạng `deepseek-chat (DeepSeek)`) |

**6 preset OpenAI-compatible:**

| id | baseUrl | defaultModel |
|---|---|---|
| `deepseek` | `https://api.deepseek.com/v1` | `deepseek-chat` |
| `qwen` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| `mistral` | `https://api.mistral.ai/v1` | `mistral-small-latest` |
| `together` | `https://api.together.xyz/v1` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` |
| `groq` | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| `openrouter` | `https://openrouter.ai/api/v1` | `openrouter/auto` |

## 2. Export cần thêm vào `packages/core/src/index.ts`

> ⚠️ Worker 1 **không được sửa** file này (phạm vi cấm). Integrator thêm
> đoạn sau vào cuối `packages/core/src/index.ts` (sau mục voice/perf):

```ts
// --- v0.5: Model registry + provider presets ---
export { ModelRegistry } from './models/index';
export type { ModelRegistryOptions } from './models/index';
export {
  COMPATIBLE_PRESETS,
  DEFAULT_FEATURE_FLAGS,
  MODELS_FILE,
  listCompatiblePresets,
  resolvePreset,
} from './models/index';
export type {
  CompatiblePreset,
  FeatureModel,
  FeatureModelMap,
  ModelInfo,
  ModelRegistrySnapshot,
  ProviderModels,
  UserModelOverrides,
  UserProviderOverrides,
} from './models/index';
export { OllamaProvider } from './providers/index'; // đã có sẵn ở đầu file — KHÔNG thêm trùng
```

Lưu ý: `OllamaProvider`, `PROVIDERS`, `createProvider` đã được export từ
đầu file — chỉ thêm khối `models` ở trên. Sau khi thêm, chạy
`npx tsc --noEmit -p packages/core/tsconfig.json` và
`npm run build --workspace=@open-bot/core` để xác nhận.

## 3. Khởi tạo registry + IPC handlers trong `apps/desktop/src/main/main.ts`

Đặt cạnh khối khởi tạo Vault/UsageTracker (hàm `initVaultAndUsage`,
quanh dòng 201). Registry sống ở main process, cùng vòng đời app:

```ts
import {
  ModelRegistry,
  MODELS_FILE,
  OllamaProvider,
  OLLAMA_BASE_URL,
  type ModelRegistrySnapshot,
} from '@open-bot/core';

const MODELS_REGISTRY_FILE = MODELS_FILE; // 'models.json'
let modelRegistry: ModelRegistry;

function initModelRegistry(userDataDir: string): void {
  modelRegistry = new ModelRegistry({
    filePath: path.join(userDataDir, MODELS_REGISTRY_FILE),
    logger: { warn: (msg: string) => console.warn(`[models] ${msg}`) },
  });
  modelRegistry.load();
}
```

Gọi `initModelRegistry(app.getPath('userData'))` trong `app.whenReady()`
cùng chỗ gọi `initVaultAndUsage(...)`. Chưa có `models.json` thì
registry chạy bằng built-in — không cần tạo file trước.

### 3.1 `models:list` — snapshot toàn bộ registry

```ts
ipcMain.handle('models:list', (): ModelRegistrySnapshot => modelRegistry.snapshot());
```

Trả về đúng hình dạng:

```ts
{
  providers: {
    xai: {
      providerId: 'xai',
      models: [{ id: 'grok-4.7', label: 'grok-4.7' }, /* ... */],
      defaultModel: 'grok-4.7',
      fallbackModel: 'grok-4.1-fast',
      features: { code: 'grok-4.7' }, // chỉ feature user đã đặt cho provider này
    },
    // ... openai, anthropic, gemini, ollama, openai-compatible
  },
  featureFlags: { voice: true, vision: false, 'long-context': false },
}
```

### 3.2 `models:set-feature` — đặt model theo feature rồi lưu

```ts
ipcMain.handle(
  'models:set-feature',
  (_event: unknown, payload: { feature: string; providerId: string; model: string }) => {
    modelRegistry.setFeatureModel(payload.feature, payload.providerId, payload.model);
    modelRegistry.save();
    return modelRegistry.snapshot();
  },
);
```

`setFeatureModel` throw khi provider lạ / feature rỗng / model rỗng —
renderer hiện lỗi bằng `models.saveError` (xem mục 7). Muốn đổi
default/fallback từ Settings thì dùng cùng mẫu với
`setDefault`/`setFallback` + `save()` — **không cần channel mới** nếu
integrator gộp vào `models:set-feature`? Không — giữ tách bạch: thêm
hai handler nhỏ cùng file, cùng quy ước trả snapshot:

```ts
ipcMain.handle(
  'models:set-default',
  (_event: unknown, payload: { providerId: string; model: string }) => {
    modelRegistry.setDefault(payload.providerId, payload.model);
    modelRegistry.save();
    return modelRegistry.snapshot();
  },
);
ipcMain.handle(
  'models:set-fallback',
  (_event: unknown, payload: { providerId: string; model: string }) => {
    modelRegistry.setFallback(payload.providerId, payload.model);
    modelRegistry.save();
    return modelRegistry.snapshot();
  },
);
```

(Hai channel này là phần mở rộng của `models:set-feature`, không nằm
trong 4 channel bắt buộc — bỏ cũng được nếu Settings chỉ sửa feature
model; nhưng Settings cần đổi default/fallback nên nên có.)

### 3.3 `models:ollama-list` — model local đã cài

```ts
function ollamaProvider(): OllamaProvider {
  return new OllamaProvider({
    id: 'ollama',
    label: 'Ollama',
    baseUrl: settings.providers['ollama']?.baseUrl || OLLAMA_BASE_URL,
  });
}

ipcMain.handle('models:ollama-list', async (): Promise<string[]> => {
  return ollamaProvider().listLocalModels();
});
```

Trả `[]` khi Ollama không chạy — renderer phân biệt "chưa có model
local" (`[]` + Ollama chạy) với "Ollama không chạy" bằng cách gọi kèm
`settings:test` provider `ollama` nếu cần; không bịa thêm channel.

### 3.4 `models:ollama-pull` — tải model, chạy nền

Pull model lớn có thể chạy nhiều phút — handler **không await**,
trả `{ ok: true }` ngay, pull chạy nền ở main; lỗi chỉ ghi log và
renderer phát hiện bằng cách gọi lại `models:ollama-list` sau đó
(model pull xong sẽ xuất hiện trong list). Chống pull trùng cùng model:

```ts
const ollamaPullsInFlight = new Set<string>();

ipcMain.handle(
  'models:ollama-pull',
  (_event: unknown, payload: { model: string }): { ok: boolean; error?: string } => {
    const model = payload?.model?.trim() ?? '';
    if (!model) return { ok: false, error: 'Tên model không được để trống.' };
    if (ollamaPullsInFlight.has(model)) return { ok: true }; // đang pull rồi
    ollamaPullsInFlight.add(model);
    ollamaProvider()
      .pullModel(model)
      .then(() => {
        console.log(`[models] Ollama pull xong: ${model}`);
      })
      .catch((err: unknown) => {
        console.error(`[models] Ollama pull lỗi (${model}):`, (err as Error).message);
      })
      .finally(() => {
        ollamaPullsInFlight.delete(model);
      });
    return { ok: true };
  },
);
```

Nếu muốn báo tiến độ/lỗi về renderer sau này: thêm event
`models:pull-done` qua `webContents.send` (mở rộng, không bắt buộc ở
v0.5; đừng đổi chữ ký `{ ok, error? }` của channel này).

## 4. Preload API — `apps/desktop/src/main/preload.ts`

Thêm vào `OpenBotApi` (sau khối vault/usage) và vào object
`contextBridge.exposeInMainWorld('openBot', ...)`:

```ts
// v0.5: Model registry + Ollama local.
listModels: () => Promise<unknown>; // ModelRegistrySnapshot (xem renderer/types.ts)
setFeatureModel: (feature: string, providerId: string, model: string) => Promise<unknown>;
setDefaultModel: (providerId: string, model: string) => Promise<unknown>;
setFallbackModel: (providerId: string, model: string) => Promise<unknown>;
listOllamaModels: () => Promise<string[]>;
pullOllamaModel: (model: string) => Promise<{ ok: boolean; error?: string }>;
```

```ts
listModels: () => ipcRenderer.invoke('models:list'),
setFeatureModel: (feature, providerId, model) =>
  ipcRenderer.invoke('models:set-feature', { feature, providerId, model }),
setDefaultModel: (providerId, model) =>
  ipcRenderer.invoke('models:set-default', { providerId, model }),
setFallbackModel: (providerId, model) =>
  ipcRenderer.invoke('models:set-fallback', { providerId, model }),
listOllamaModels: () => ipcRenderer.invoke('models:ollama-list'),
pullOllamaModel: (model) => ipcRenderer.invoke('models:ollama-pull', { model }),
```

Đồng bộ type trong `apps/desktop/src/renderer/global.d.ts` (nó khai
`window.openBot: OpenBotApi`) và thêm type sau vào
`apps/desktop/src/renderer/types.ts`:

```ts
export interface ModelRegistrySnapshotLike {
  providers: Record<
    string,
    {
      providerId: string;
      models: Array<{ id: string; label: string }>;
      defaultModel: string;
      fallbackModel: string;
      features: Record<string, string>;
    }
  >;
  featureFlags: Record<string, boolean>;
}
```

## 5. Thay đổi renderer

### 5.1 `SettingsView.tsx` — thêm mục "Model registry"

> ⚠️ File này đang được worker khác sửa song song (team) — integrator
> merge cẩn thận, đừng ghi đè thay đổi của họ.

Thêm một section mới sau mục provider (dưới form API key/base URL),
dùng dữ liệu từ `window.openBot.listModels()` (gọi một lần khi mở
Settings, và sau mỗi lần set để refresh):

1. **Per provider** (lặp `PROVIDER_META` từ `PROVIDERS`, dùng
   `t('settings.provider.<id>')` cho label):
   - Dropdown **Model mặc định**: options = `snapshot.providers[id].models`,
     value = `defaultModel`; đổi → `setDefaultModel(id, model)`.
   - Dropdown **Model dự phòng**: value = `fallbackModel`;
     đổi → `setFallbackModel(id, model)`.
   - Với `openai-compatible`: thêm dropdown **Preset** (options =
     `meta.presets` — đã có trong `PROVIDER_META` qua `PROVIDERS`;
     chọn preset → điền `baseUrl` + `defaultModel` của preset vào
     draft provider rồi lưu bằng flow `settings:set` hiện có).
   - **Model theo feature**: với mỗi feature trong danh sách cố định
     `['chat', 'code', 'research', 'voice', 'vision', 'long-context']`,
     một dropdown (options = model của provider đó + mục "— dùng mặc
     định —" ứng với `features[feature]` chưa đặt); đổi →
     `setFeatureModel(feature, id, model)`. Chỉ hiện feature nào
     hợp với provider? Không — hiện đủ 6 feature cho mọi provider,
     vì feature là key mở và user có thể gán bất kỳ model nào.
2. **Model local Ollama** (chỉ khi provider `ollama` có trong snapshot):
   - Danh sách `listOllamaModels()` (kèm nút Làm mới).
   - Ô nhập tên model + nút Pull → `pullOllamaModel(model)`; khi
     `{ ok: false }` hiện `error`; khi `{ ok: true }` hiện trạng thái
     "đang tải" và gợi ý bấm Làm mới để kiểm tra (pull chạy nền, xem
     mục 3.4). Rỗng list → hiện `models.localEmpty`.
   - Sau khi pull xong, model mới cũng có thể được chọn làm default /
     feature model của Ollama (vì `setDefault`/`setFeatureModel`
     tự thêm model lạ vào catalogue user).
3. **Feature flags**: checkbox cho từng flag trong
   `snapshot.featureFlags` (`voice`, `vision`, `long-context`) —
   đổi → gọi `models:set-feature`? Không — flag chưa có channel
   riêng. Integrator thêm handler `models:set-flag` ở main
   (`setFeatureFlag(name, enabled)` + `save()`, trả snapshot) và
   preload `setFeatureFlag(name, enabled)` theo đúng mẫu mục 3.2/4,
   rồi nối checkbox vào đó. (Worker 1 đã có sẵn `setFeatureFlag` ở
   core; chỉ thiếu channel.)
4. **Lưu ý hiển thị:** mọi chuỗi qua `t('models.…')` (mục 7); lỗi
   tải/lưu dùng `models.loadError` / `models.saveError`; không log
   API key; không hiện tên model hard-code trong JSX — model nào
   cũng lấy từ snapshot.

### 5.2 `BotForm.tsx` + bot mặc định — bỏ hard-code `'grok-4.7'`

Hiện trạng cần sửa:

- `apps/desktop/src/main/main.ts` `ensureDefaultBot()`: `model: 'grok-4.7'`
  → `model: modelRegistry.getDefault('xai')`.
- `apps/desktop/src/main/main.ts` `bots:create`: hiện đã fallback
  `settings.providers[providerId]?.defaultModel ?? ''` — đổi thành
  `modelRegistry.getDefault(providerId)` làm nguồn chính, giữ
  settings làm fallback khi registry trả `''` (trường hợp
  `openai-compatible` chưa chọn preset):
  ```ts
  model:
    config.model ??
    modelRegistry.getDefault(config.providerId ?? 'xai') ||
    settings.providers[config.providerId ?? 'xai']?.defaultModel ??
    '',
  ```
- `apps/desktop/src/renderer/components/BotForm.tsx` dòng
  `useState(initial?.model ?? 'grok-4.7')` → `useState(initial?.model ?? '')`
  và placeholder của ô model lấy từ registry: khi `providerId` đổi,
  gọi `listModels()` (hoặc nhận snapshot qua props từ App) để hiện
  `defaultModel` của provider đó làm gợi ý; để trống = dùng model mặc
  định của provider (đúng hint `botForm.modelHint` đã có).
- `packages/core/src/agent/templates.ts`: 6 template vẫn hard-code
  `model: 'grok-4.7'` — **ngoài phạm vi worker 1**, integrator ghi
  nhận làm việc tồn đọng: khi áp template (`createBotConfigFromTemplate`
  / `applyTemplate` ở BotForm), nếu template không chỉ định model
  riêng thì resolve bằng `registry.getDefault(template.providerId)`.
  Đừng sửa `templates.ts` trong lúc nối v0.5 nếu chưa có test cho nó.

## 6. Kiểm thử đã có (worker 1)

`tests/models.test.mjs` — chạy sau khi build core:

```bash
npm run build --workspace=@open-bot/core
node --test tests/models.test.mjs
```

18 test, đều pass tại thời điểm bàn giao (xem báo cáo worker 1):
registry mặc định (catalogue/default/fallback từng provider),
snapshot đúng hình `models:list`, merge ghi đè user, provider lạ bị
bỏ qua + warn, `setDefault` tự thêm model lạ, feature model fallback
về default khi chưa đặt, feature flag bật/tắt, `models.json` hỏng
không crash, mục hỏng trong file bị bỏ qua nhưng mục tốt giữ lại,
thiếu file = built-in, save/load round-trip chỉ ghi delta,
`save()` không filePath throw, 6 preset đủ + baseUrl đúng,
`PROVIDERS` meta có presets, `pullModel` với mock fetch (ghi lại
body request, NDJSON progress rồi success; status error → throw;
HTTP lỗi → throw), `listLocalModels` (`/api/tags`, Ollama chết → `[]`).

Chưa test live: chưa có API key thật; pull thật chỉ mới test bằng
mock fetch. Nên kiểm tra tay sau khi nối UI: mở Ollama local
(`http://localhost:11434`, model `qwen2.5:0.5b` đang có), bấm
"Làm mới" ở mục Ollama và pull thử `qwen2.5:0.5b` (đã có sẵn → xong
ngay).

## 7. Chuỗi i18n cần thêm — `apps/desktop/src/renderer/i18n/locales/{vi,en}.json`

File locale là JSON một dòng (flat key). Thêm các key sau (giữ đúng
format, thêm vào cuối object trước dấu `}`):

| Key | vi | en |
|---|---|---|
| `models.title` | `Model & provider` | `Models & providers` |
| `models.intro` | `Model mặc định, model dự phòng và model theo từng việc — lấy từ registry, không hard-code trong app.` | `Default, fallback and per-task models — served by the registry, never hard-coded in the app.` |
| `models.defaultLabel` | `Model mặc định` | `Default model` |
| `models.fallbackLabel` | `Model dự phòng` | `Fallback model` |
| `models.presetLabel` | `Preset có sẵn` | `Preset` |
| `models.presetNone` | `— Tự nhập base URL —` | `— Custom base URL —` |
| `models.featureLabel` | `Model theo việc` | `Model per task` |
| `models.featureDefault` | `— Dùng model mặc định —` | `— Use default model —` |
| `models.feature.chat` | `Chat chung` | `General chat` |
| `models.feature.code` | `Lập trình` | `Coding` |
| `models.feature.research` | `Nghiên cứu` | `Research` |
| `models.feature.voice` | `Thoại` | `Voice` |
| `models.feature.vision` | `Nhìn ảnh` | `Vision` |
| `models.feature.long-context` | `Ngữ cảnh dài` | `Long context` |
| `models.flagsTitle` | `Feature flag` | `Feature flags` |
| `models.flag.voice` | `Thoại (voice call + voice memo)` | `Voice (voice calls + voice memos)` |
| `models.flag.vision` | `Nhìn ảnh (thử nghiệm)` | `Vision (experimental)` |
| `models.flag.long-context` | `Ngữ cảnh dài (thử nghiệm)` | `Long context (experimental)` |
| `models.localTitle` | `Model local (Ollama)` | `Local models (Ollama)` |
| `models.localEmpty` | `Chưa có model local nào. Pull một model bên dưới.` | `No local models yet. Pull one below.` |
| `models.localRefresh` | `Làm mới` | `Refresh` |
| `models.localPull` | `Pull model` | `Pull model` |
| `models.localPullPlaceholder` | `vd: qwen2.5:0.5b` | `e.g. qwen2.5:0.5b` |
| `models.localPulling` | `Đang tải “{model}” ở nền — bấm Làm mới để kiểm tra.` | `Downloading “{model}” in the background — press Refresh to check.` |
| `models.localPullError` | `Không pull được model: {message}` | `Could not pull the model: {message}` |
| `models.loadError` | `Không tải được danh sách model.` | `Could not load the model list.` |
| `models.saveError` | `Không lưu được cài đặt model.` | `Could not save the model settings.` |

Key feature flag hiển thị động: UI nên render `t('models.flag.' + name)`
với fallback là chính `name` khi key chưa có (flag mới do user thêm
trong `models.json` không cần release mới để có chuỗi).

## 8. Giới hạn còn tồn đọng (không phải lỗi, integrator lưu ý)

- **Chưa nối UI**: core + test xong; main/preload/SettingsView/BotForm
  vẫn ở trạng thái v0.4 (bot mặc định và BotForm còn hard-code
  `'grok-4.7'`).
- **Chưa có channel flag**: core có `setFeatureFlag`, nhưng chưa có
  IPC `models:set-flag` — integrator thêm theo mẫu mục 3.2/5.1.
- **Pull không có tiến độ trực tiếp**: `models:ollama-pull` chạy nền,
  renderer biết xong bằng cách gọi lại `models:ollama-list`. Muốn
  progress bar thì thêm event `models:pull-done` / progress sau.
- **`models.json` là file local**: không đồng bộ giữa các máy, không
  có server cấu hình từ xa (đúng định vị local-first của v0.5; mục
  2d ROADMAP "server trả về danh sách model" được thay bằng file
  local này).
- **Chưa test live**: chưa có key Grok/OpenAI thật; pull Ollama thật
  chưa thử qua UI (chỉ mock fetch trong test).
- **Templates còn hard-code model**: xem mục 5.2.
- **Xung đột file khi tích hợp**: `SettingsView.tsx`,
  `TeamView.tsx`, `global.d.ts`, locale `vi.json`/`en.json` đang được
  worker khác sửa song song (team/API v0.5) — merge tay, chạy lại
  `npx tsc --noEmit -p packages/core/tsconfig.json` và test
  `node --test tests/models.test.mjs` sau merge.
