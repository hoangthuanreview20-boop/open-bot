# Đặc tả tích hợp v0.4 — Vault + Spend Limit (worker 1)

> Tài liệu này dành cho **điều phối viên**: áp dụng các thay đổi dưới đây
> vào `apps/desktop` (main / preload / renderer) và `packages/core`
> (export + coordinator). Mọi code mẫu đã viết sẵn để dán vào — không viết
> chung chung. Code lõi (Vault, UsageTracker, MeteredProvider, bảng giá)
> đã xong và đã có test, xem §1.
>
> **Không sửa trong đợt này:** `docs/ROADMAP.md` (điều phối viên tự tick
> checklist sau khi nối xong), `packages/tools/*`.

## 1. Cái đã có sẵn (worker 1 đã làm, đã test)

| Hạng mục | File | Export chính |
|---|---|---|
| Vault | `packages/core/src/vault/vault.ts`, `index.ts` | `Vault`, `LocalEncryptor`, `createSafeStorageEncryptor`, `loadOrCreateMachineKey`; type `Encryptor`, `SafeStorageLike`, `VaultOptions` |
| Usage + pricing | `packages/core/src/usage/usage.ts`, `pricing.ts`, `index.ts` | `UsageTracker`, `MeteredProvider`, `SpendLimitError`; `estimateCost`, `getModelPrice`, `registerPrice`; type `SpendLimits`, `SpendStatus`, `UsageSummary` |
| Test | `tests/vault.test.mjs`, `tests/usage.test.mjs` | chạy bằng `node --test tests/vault.test.mjs tests/usage.test.mjs` sau khi build core |

### 1.1. API Vault (đồng bộ, như `BotMemory`)

```ts
import { Vault, createSafeStorageEncryptor } from '@open-bot/core';

const vault = new Vault({
  storePath: '<userData>/vault.json',
  // Khi có safeStorage: truyền encryptor; khi không: bỏ trống để dùng
  // LocalEncryptor fallback (key file mặc định: vault.json.key).
  encryptor: createSafeStorageEncryptor(safeStorage),
});
vault.setSecret('provider', 'xai', apiKey);      // ghi đè nếu đã có
vault.getSecret('provider', 'xai');              // string | null
vault.hasSecret('provider', 'xai');              // boolean
vault.deleteSecret('provider', 'xai');           // boolean
vault.listSecrets('provider');                   // string[] — CHỈ tên key, không bao giờ trả value
vault.listNamespaces();                          // string[]
vault.rotateKey();                               // LocalEncryptor: sinh key file mới, mã hoá lại toàn bộ
vault.rotateKey(newEncryptor);                   // migrate sang backend khác (vd: Local -> safeStorage)
```

Namespace quy ước: `'provider'` (API key, key = provider id),
`'mcp'` (credential MCP server, key = server id), `'plugin'`,
`'oauth'` (refresh token), `'session'` (session token). Ba loại
credential (session / OAuth refresh / API key) tách namespace riêng,
không trộn lẫn. **Không bao giờ log giá trị secret** — `Vault` không
log gì cả; code gọi cũng không được `console.log` secret hay
`settings` sau khi đã chứa key.

### 1.2. API UsageTracker (đồng bộ, file JSON `<userData>/usage.json`)

```ts
import { UsageTracker, MeteredProvider, SpendLimitError } from '@open-bot/core';

const tracker = new UsageTracker({ storePath: '<userData>/usage.json' });
tracker.record('bot-id', 'xai', 'grok-4.7', { inputTokens: 1200, outputTokens: 300 });
// recordResponse(botId, providerId, model, providerResponse) — no-op khi response không có usage.

tracker.getSummary('today' | 'month' | 'all', botId?);
// -> { inputTokens, outputTokens, costUsd: number | null, calls, unpricedCalls }
//    costUsd = null khi có BẤT KỲ record nào trong khoảng chưa có giá (model lạ)
//    — token vẫn đếm, tiền không đoán mò. Ollama luôn cost 0 (chạy local).

tracker.getSpendStatus(botId?);
// -> { today: SpendWindow, month: SpendWindow, total: SpendWindow }
//    SpendWindow = UsageSummary & { limitUsd?: number; percentUsed: number | null }

tracker.setLimits({ dailyUsd: 5, monthlyUsd: 50, totalUsd: 500,
                    perBot: { '<botId>': { dailyUsd: 1 } } }); // {} = xoá hết limit
tracker.getLimits();                 // SpendLimits (bản copy)
tracker.checkLimits(botId?);         // LimitViolation[] — global trước, per-bot sau
tracker.assertWithinLimits(botId?);  // throw SpendLimitError khi vượt
tracker.reset('day' | 'month' | 'all'); // xoá record trong khoảng, TRẢ VỀ số record đã xoá; limit giữ nguyên
tracker.reload();                    // đọc lại file (xem §3.3 — hai tiến trình cùng ghi file)
```

`SpendLimitError` (message tiếng Anh, UI hiển thị verbatim, vd):
`Spend limit exceeded (daily): spent $2.00 of $1.00 limit. Raise the
limit in Settings or wait for the limit to reset.` — các field:
`scope` (`'daily'|'monthly'|'total'|'bot-daily'|'bot-monthly'|'bot-total'`),
`spentUsd`, `limitUsd`, `botId?`. **Ngày/tháng tính theo lịch LOCAL của
máy**; sang ngày/tháng mới thì cửa sổ tự sạch — `reset()` chỉ là hành
động xoá lịch sử thủ công do người dùng bấm nút.

### 1.3. MeteredProvider — wrapper quanh bất kỳ Provider nào

```ts
const metered = new MeteredProvider(innerProvider, tracker, { botId: bot.id });
await metered.chat(req);   // check limit TRƯỚC khi gọi inner; ghi usage SAU khi có response
metered.listModels();      // passthrough (không tốn tiền)
metered.wrapped;           // inner provider
metered.usageTracker;      // tracker
```

Lưu ý: check là pre-call — không biết trước chi phí của call sắp tới,
nên một call có thể đẩy spend vượt cap một chút; call TIẾP THEO sẽ bị
chặn. `MeteredProvider.chat()` tự gọi `tracker.reload()` trước mỗi
lần check (xem §3.3).

### 1.4. Bảng giá (`pricing.ts`)

`estimateCost(model, inTok, outTok): number | null`,
`getModelPrice(model): ModelPrice | null`,
`registerPrice(model, { inputPerMillionUsd, outputPerMillionUsd })`
(ghi đè / thêm giá lúc chạy), `listPricedModels()`. Giá mặc định
(USD/1M token, đã kiểm chứng từ trang pricing công khai của provider
ngày 2026-11-08): grok-4.7 2/6, grok-4.6 2/6, grok-4.5 2/6,
grok-4.3 1.25/2.5, grok-4 3/15, grok-4.1-fast 0.2/0.5,
grok-build-0.1 1/2; gpt-5 1.25/10, gpt-5-mini 0.25/2,
gpt-5-nano 0.05/0.4, gpt-5.5 5/30, gpt-5.4 2.5/15, gpt-4o 2.5/10,
gpt-4o-mini 0.15/0.6; claude-sonnet-4.5 3/15, claude-sonnet-4.6 3/15,
claude-haiku-4.5 1/5, claude-opus-4.1 15/75, claude-sonnet-5 2/10;
gemini-2.5-pro 1.25/10, gemini-2.5-flash 0.3/2.5,
gemini-2.5-flash-lite 0.1/0.4. Model có hậu tố ngày
(`grok-4.7-2026-09-21`) được kế thừa giá của model gốc (prefix match).
Đây là **ước tính hiển thị**, không phải hoá đơn.

---

## 2. Bước 0 — export từ `@open-bot/core` (bắt buộc trước mọi bước khác)

Worker 1 **không được sửa** `packages/core/src/index.ts`, nên Vault /
Usage hiện chỉ import được qua deep path. Điều phối viên thêm vào cuối
`packages/core/src/index.ts` (giữ đúng thứ tự nhóm export hiện có):

```ts
export { Vault, LocalEncryptor, createSafeStorageEncryptor, loadOrCreateMachineKey } from './vault/index';
export type { Encryptor, SafeStorageLike, VaultOptions } from './vault/index';

export { UsageTracker, MeteredProvider, SpendLimitError } from './usage/index';
export type {
  LimitScope,
  LimitViolation,
  MeteredProviderOptions,
  SpendLimits,
  SpendStatus,
  SpendWindow,
  UsageRecord,
  UsageSummary,
  UsageTrackerOptions,
} from './usage/index';
export { estimateCost, getModelPrice, listPricedModels, registerPrice, unregisterPrice } from './usage/index';
export type { ModelPrice } from './usage/index';
```

Sau đó chạy `npm run build --workspace=@open-bot/core` rồi
`node --test tests/vault.test.mjs tests/usage.test.mjs` để xác nhận.

---

## 3. Main process — `apps/desktop/src/main/main.ts`

### 3.1. Khởi tạo Vault + UsageTracker (đặt cạnh `loadSettings`)

```ts
import { safeStorage } from 'electron';
import {
  Vault,
  UsageTracker,
  createSafeStorageEncryptor,
  type SpendLimits,
} from '@open-bot/core';

const VAULT_FILE = 'vault.json';
const USAGE_FILE = 'usage.json';
let vault: Vault;
let usageTracker: UsageTracker;

function initVaultAndUsage(userDataDir: string): void {
  // safeStorage là backend chính; khi OS không có keychain/DPAPI thì
  // createSafeStorageEncryptor throw -> fallback LocalEncryptor
  // (key file vault.json.key, mode 0600) + log cảnh báo MỘT dòng.
  try {
    vault = new Vault({
      storePath: path.join(userDataDir, VAULT_FILE),
      encryptor: createSafeStorageEncryptor(safeStorage),
    });
  } catch (err) {
    console.error('[open-bot] safeStorage không khả dụng, dùng LocalEncryptor fallback:',
      (err as Error).message);
    vault = new Vault({ storePath: path.join(userDataDir, VAULT_FILE) });
  }
  usageTracker = new UsageTracker({ storePath: path.join(userDataDir, USAGE_FILE) });
}
```

Gọi `initVaultAndUsage(app.getPath('userData'))` trong
`app.whenReady()` **trước** `settings = loadSettings();` vì bước 3.2
(migration) cần vault đã sẵn sàng. `settings` vẫn giữ trường
`providers[id].apiKey` trong type `ProviderSettings` (để tương thích
file cũ) nhưng sau migration giá trị luôn là `''` — xem §3.2.

### 3.2. Migration: dời API key từ `settings.json` sang Vault (chạy 1 lần lúc khởi động)

Thêm vào cuối `loadSettings()` — sau khi `settings` đã load xong,
**trước** `ensureDefaultBot()` — hoặc thành hàm riêng gọi ngay sau
`loadSettings()` trong `whenReady`:

```ts
/**
 * Migration v0.4 (chạy 1 lần): key còn nằm trong settings.json được
 * dời sang Vault rồi xoá khỏi settings. Sau migration, settings.json
 * KHÔNG BAO GIỜ chứa API key nữa. Hàm này idempotent: chạy lại lần
 * nữa không làm gì vì apiKey đã rỗng.
 */
function migrateApiKeysToVault(): void {
  let moved = false;
  for (const [id, p] of Object.entries(settings.providers)) {
    const key = p.apiKey?.trim();
    if (!key) continue;
    if (!vault.hasSecret('provider', id)) {
      vault.setSecret('provider', id, key);
    }
    p.apiKey = '';
    moved = true;
  }
  if (moved) {
    saveSettings();
    console.log('[open-bot] Đã dời API key từ settings.json sang Vault.');
  }
}
```

Thứ tự trong `whenReady` sau khi sửa:

```ts
void app.whenReady().then(() => {
  initVaultAndUsage(app.getPath('userData'));
  settings = loadSettings();
  migrateApiKeysToVault();
  ensureDefaultBot();
  registerIpc();
  createWindow();
  // ...
});
```

### 3.3. Đọc key từ Vault thay vì `settings.providers`

Sửa `providerConfigFor` (hàm hiện tại đọc `settings.providers[providerId]`):

```ts
function providerConfigFor(providerId: string, modelOverride?: string): ProviderConfig {
  const saved = settings.providers[providerId];
  const meta = PROVIDERS.find((m) => m.id === providerId);
  // API key sống trong Vault, KHÔNG còn trong settings.json (v0.4).
  const apiKey = vault.getSecret('provider', providerId) ?? undefined;
  return {
    id: providerId,
    label: meta?.label ?? providerId,
    apiKey,
    baseUrl: saved?.baseUrl || undefined,
    defaultModel: modelOverride || saved?.defaultModel || meta?.defaultModel || '',
  };
}
```

Và `settingsForRenderer()` — đổi `Boolean(p.apiKey)` thành
`vault.hasSecret('provider', id)`:

```ts
providers[id] = { apiKeySet: vault.hasSecret('provider', id), baseUrl: p.baseUrl, defaultModel: p.defaultModel };
```

**Hai tiến trình cùng ghi `usage.json`:** coordinator (tiến trình con)
ghi usage qua `MeteredProvider`, main ghi limits/reset qua IPC.
`MeteredProvider.chat()` đã tự `tracker.reload()` trước mỗi lần check,
nên limit đổi ở Settings có hiệu lực ngay ở call tiếp theo. Main KHÔNG
giữ `usageTracker` dài hạn cho việc đọc: mỗi IPC handler dưới đây tạo
`usageTracker` mới hoặc dùng instance đã có nhưng gọi `reload()` trước
khi đọc (instance ở §3.1 đã làm vậy qua `reload()` trong handler —
xem code mẫu §3.4, đã có `usageTracker.reload()` ở đầu mỗi handler).

### 3.4. IPC handlers mới — đặt trong `registerIpc()`, sau nhóm `settings:*`

```ts
// --- v0.4: Vault (secret KHÔNG BAO GIỜ rời main process) ---
ipcMain.handle('vault:list', () => {
  // Trả về tên key theo namespace — KHÔNG trả value.
  const out: Record<string, string[]> = {};
  for (const ns of vault.listNamespaces()) out[ns] = vault.listSecrets(ns);
  return out;
});

ipcMain.handle('vault:set', (_event: unknown, payload: { namespace: string; key: string; value: string }) => {
  if (typeof payload.value !== 'string' || payload.value.length === 0) {
    throw new Error('Secret trống.');
  }
  vault.setSecret(payload.namespace, payload.key, payload.value);
  // Key provider đổi -> runtime cũ dùng key cũ phải bỏ.
  if (payload.namespace === 'provider') {
    for (const bot of settings.bots.filter((b) => b.providerId === payload.key)) {
      void invalidateRuntime(bot.id);
    }
  }
  return true;
});

ipcMain.handle('vault:delete', (_event: unknown, payload: { namespace: string; key: string }) => {
  const removed = vault.deleteSecret(payload.namespace, payload.key);
  if (removed && payload.namespace === 'provider') {
    for (const bot of settings.bots.filter((b) => b.providerId === payload.key)) {
      void invalidateRuntime(bot.id);
    }
  }
  return removed;
});

// --- v0.4: Usage + spend limit ---
ipcMain.handle('usage:get', (_event: unknown, payload?: { botId?: string }) => {
  usageTracker.reload();
  return usageTracker.getSpendStatus(payload?.botId);
});

ipcMain.handle('usage:get-limits', () => {
  usageTracker.reload();
  return usageTracker.getLimits();
});

ipcMain.handle('usage:set-limits', (_event: unknown, limits: SpendLimits) => {
  usageTracker.reload();
  usageTracker.setLimits(limits); // throw khi limit <= 0 / không phải số
  return usageTracker.getLimits();
});

ipcMain.handle('usage:reset', (_event: unknown, payload: { scope: 'day' | 'month' | 'all' }) => {
  usageTracker.reload();
  const removed = usageTracker.reset(payload.scope);
  return { removed, status: usageTracker.getSpendStatus() };
});
```

### 3.5. Sửa handler `settings:set` — key mới đi vào Vault, không vào settings

Trong handler `settings:set` hiện tại, thay đoạn gán `apiKey`:

```ts
for (const [id, p] of Object.entries(patch.providers ?? {})) {
  const prev = settings.providers[id] ?? { apiKey: '', baseUrl: '', defaultModel: '' };
  settings.providers[id] = {
    // v0.4: API key KHÔNG lưu vào settings.json nữa — vào Vault.
    // apiKey rỗng = giữ key cũ trong Vault (renderer không gửi key thật về).
    apiKey: '',
    baseUrl: p.baseUrl ?? prev.baseUrl,
    defaultModel: p.defaultModel ?? prev.defaultModel,
  };
  if (p.apiKey && p.apiKey.length > 0) {
    vault.setSecret('provider', id, p.apiKey);
  }
  // Provider đổi cấu hình -> runtime cũ dùng key/model cũ phải bỏ.
  for (const bot of settings.bots.filter((b) => b.providerId === id)) {
    void invalidateRuntime(bot.id);
  }
}
```

### 3.6. Nối MeteredProvider trong coordinator (provider chạy ở tiến trình con)

Provider thật được tạo trong `packages/core/src/coordinator/coordinator.ts`
(`createBot`: `createProvider(params.provider)`). Sửa ở đó — **không
phải main** — theo 3 bước:

**a.** Thêm field vào `CreateBotParams`
(`packages/core/src/coordinator/types.ts`, cạnh `pluginsDir`):

```ts
/** Path of the usage store file (`<userData>/usage.json`). When set, the
 *  bot's provider is wrapped in a MeteredProvider that enforces spend
 *  limits and records token usage. */
usageStorePath?: string;
```

**b.** Trong `coordinator.ts`, `createBot()`, sau khi tạo `provider`:

```ts
import { MeteredProvider, UsageTracker } from '../usage/index';

// Trong class AgentCoordinator — một tracker chung cho cả tiến trình con
// (limit global + per-bot đều nằm trong cùng một file usage.json):
private usageTracker: UsageTracker | null = null;

private getUsageTracker(storePath: string): UsageTracker {
  if (!this.usageTracker || this.usageTracker.path !== storePath) {
    this.usageTracker = new UsageTracker({ storePath });
  }
  return this.usageTracker;
}

// Trong createBot(), ngay sau dòng tạo `provider`:
let provider: Provider =
  params.provider.id === 'mock'
    ? createMockProvider(params.provider.mockResponses ?? [])
    : createProvider(params.provider);
// v0.4: MeteredProvider — check spend limit trước mỗi chat(), ghi usage sau.
// Mock provider không tốn tiền thật nhưng vẫn đi qua Metered để test limit.
if (params.usageStorePath) {
  provider = new MeteredProvider(provider, this.getUsageTracker(params.usageStorePath), {
    botId: fullBot.id,
  });
}
```

**c.** Trong `main.ts`, `getOrCreateRuntime()` — truyền thêm đường dẫn
usage vào `createBot` (cạnh `pluginsDir` đã có):

```ts
await getCoordinator().createBot({
  bot,
  provider: providerConfigFor(bot.providerId, bot.model),
  workspaceDir,
  pluginsDir: path.join(app.getPath('userData'), 'plugins'),
  usageStorePath: path.join(app.getPath('userData'), USAGE_FILE),
});
```

**Hành vi khi vượt limit:** `MeteredProvider.chat()` throw
`SpendLimitError`; `AgentRunner.run()` không catch riêng nên lỗi nổi lên
`coordinator.run()` → `chat:send` trong main đã trả `{ ok: false, error }`
— renderer hiển thị message tiếng Anh đó verbatim (đã có số tiền
đã dùng / giới hạn). Không cần handler lỗi riêng.

---

## 4. Preload — `apps/desktop/src/main/preload.ts`

Thêm vào `OpenBotApi` (sau nhóm `settings:*`, theo đúng pattern hiện có):

```ts
// v0.4: Vault (chỉ tên key, không bao giờ trả secret) + Usage.
listVaultSecrets: () => Promise<Record<string, string[]>>;
setVaultSecret: (namespace: string, key: string, value: string) => Promise<boolean>;
deleteVaultSecret: (namespace: string, key: string) => Promise<boolean>;
getUsage: (botId?: string) => Promise<unknown>;
getSpendLimits: () => Promise<unknown>;
setSpendLimits: (limits: unknown) => Promise<unknown>;
resetUsage: (scope: 'day' | 'month' | 'all') => Promise<{ removed: number; status: unknown }>;
```

Và vào object `openBot`:

```ts
listVaultSecrets: () => ipcRenderer.invoke('vault:list'),
setVaultSecret: (namespace, key, value) => ipcRenderer.invoke('vault:set', { namespace, key, value }),
deleteVaultSecret: (namespace, key) => ipcRenderer.invoke('vault:delete', { namespace, key }),
getUsage: (botId) => ipcRenderer.invoke('usage:get', { botId }),
getSpendLimits: () => ipcRenderer.invoke('usage:get-limits'),
setSpendLimits: (limits) => ipcRenderer.invoke('usage:set-limits', limits),
resetUsage: (scope) => ipcRenderer.invoke('usage:reset', { scope }),
```

---

## 5. Renderer — `SettingsView.tsx` + banner

### 5.1. Mục Vault trong Settings (thay thế form key cũ)

Form API key từng provider **giữ nguyên giao diện** (ô password +
badge "Đã lưu key") nhưng đổi đích lưu: `save()` hiện gửi
`setSettings({ providers })` — giữ nguyên, vì main (§3.5) đã tự dời
key vào Vault. Chỉ thêm **một section mới** sau section ngôn ngữ,
trước danh sách provider, hiển thị trạng thái Vault:

```tsx
const [vaultSecrets, setVaultSecrets] = useState<Record<string, string[]>>({});
const [usage, setUsage] = useState<unknown>(null);

// Trong useEffect load settings hiện có, thêm:
window.openBot.listVaultSecrets().then(setVaultSecrets).catch(() => undefined);
window.openBot.getUsage().then(setUsage).catch(() => undefined);

// Section Vault (đặt sau section ngôn ngữ):
<section className="card">
  <h3>{t('settings.vaultTitle')}</h3>
  <p className="hint">{t('settings.vaultIntro')}</p>
  {Object.keys(vaultSecrets).length === 0 && <p>{t('settings.vaultEmpty')}</p>}
  {Object.entries(vaultSecrets).map(([ns, keys]) => (
    <div key={ns}>
      <strong>{ns}</strong>
      <ul>
        {keys.map((k) => (
          <li key={k}>
            {k}{' '}
            <button
              className="btn secondary"
              onClick={() => {
                if (!window.confirm(t('settings.vaultDeleteConfirm', { key: k }))) return;
                void window.openBot.deleteVaultSecret(ns, k)
                  .then(() => window.openBot.listVaultSecrets().then(setVaultSecrets));
              }}
            >
              {t('settings.vaultDelete')}
            </button>
          </li>
        ))}
      </ul>
    </div>
  ))}
  <p className="hint">{t('settings.vaultHint')}</p>
</section>
```

**Không hiển thị giá trị secret ở bất kỳ đâu.** Nút xoá hỏi confirm
trước. Key provider xoá ở đây thì bot dùng provider đó sẽ lỗi
"chưa nhập key" ở lần chạy sau (đúng hành vi cũ khi xoá key).

### 5.2. Usage banner (trong Settings, trên cùng — trước section ngôn ngữ)

```tsx
interface SpendWindowView {
  inputTokens: number; outputTokens: number;
  costUsd: number | null; calls: number; unpricedCalls: number;
  limitUsd?: number; percentUsed: number | null;
}
interface SpendStatusView { today: SpendWindowView; month: SpendWindowView; total: SpendWindowView; }

// State: const [usage, setUsage] = useState<SpendStatusView | null>(null);
// Load: window.openBot.getUsage().then(setUsage) trong useEffect hiện có.
// Refresh sau mỗi lần chat xong: App.tsx gọi lại getUsage() khi nhận
// chat:summary / khi quay lại Settings (đủ cho v0.4, chưa cần live push).

{usage && (
  <section className="card">
    <h3>{t('settings.usageTitle')}</h3>
    <p>
      {t('settings.usageToday', {
        cost: usage.today.costUsd === null ? t('settings.usageUnknown') : `$${usage.today.costUsd.toFixed(2)}`,
        tokens: String(usage.today.inputTokens + usage.today.outputTokens),
      })}
    </p>
    <p>
      {t('settings.usageMonth', {
        cost: usage.month.costUsd === null ? t('settings.usageUnknown') : `$${usage.month.costUsd.toFixed(2)}`,
        tokens: String(usage.month.inputTokens + usage.month.outputTokens),
      })}
    </p>
    {usage.today.limitUsd !== undefined && usage.today.percentUsed !== null && (
      <p className={usage.today.percentUsed >= 100 ? 'error' : ''}>
        {t('settings.usageDailyLimit', {
          percent: usage.today.percentUsed.toFixed(0),
          limit: usage.today.limitUsd.toFixed(2),
        })}
      </p>
    )}
    {usage.today.unpricedCalls > 0 && (
      <p className="hint">{t('settings.usageUnpriced', { count: String(usage.today.unpricedCalls) })}</p>
    )}
  </section>
)}
```

### 5.3. Form đặt limit + reset (đặt cuối SettingsView, sau danh sách provider)

```tsx
const [limits, setLimits] = useState<{ dailyUsd?: number; monthlyUsd?: number }>({});
// Load: window.openBot.getSpendLimits().then(setLimits) trong useEffect.
// Lưu:
const saveLimits = async () => {
  const next = await window.openBot.setSpendLimits({
    dailyUsd: limits.dailyUsd || undefined,
    monthlyUsd: limits.monthlyUsd || undefined,
  });
  setLimits(next);
};
// Reset:
const resetUsage = async (scope: 'day' | 'month' | 'all') => {
  if (!window.confirm(t('settings.usageResetConfirm'))) return;
  const res = await window.openBot.resetUsage(scope);
  setUsage(res.status);
};
```

Input là `<input type="number" min="0" step="0.01">`; để trống = không
giới hạn (gửi `undefined`). Nút reset có 3 lựa chọn (ngày / tháng /
tất cả) — dùng 3 nút nhỏ, mỗi nút confirm riêng.

### 5.4. Kiểu dữ liệu renderer — `apps/desktop/src/renderer/types.ts`

Thêm vào `SettingsView` (kiểu dữ liệu settings hiện có) — không bắt
buộc nếu dùng `unknown`, nhưng nên khai báo để khỏi `any`:

```ts
export interface SpendWindowData {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  calls: number;
  unpricedCalls: number;
  limitUsd?: number;
  percentUsed: number | null;
}
export interface SpendStatusData {
  today: SpendWindowData;
  month: SpendWindowData;
  total: SpendWindowData;
}
```

---

## 6. i18n — thêm vào `vi.json` và `en.json`

Thêm các key sau vào **cả hai** file locale (đặt sau nhóm
`settings.*` hiện có; chuỗi `{name}` là placeholder của `interpolate`,
đã dùng ở các key cũ như `settings.vaultDeleteConfirm`):

**vi.json:**

```json
"settings.vaultTitle": "Kho secret (Vault)",
"settings.vaultIntro": "API key và credential được mã hoá và lưu tách riêng khỏi cài đặt, không bao giờ hiện lại giá trị.",
"settings.vaultEmpty": "Chưa có secret nào trong Vault.",
"settings.vaultHint": "Key provider nhập ở mục dưới sẽ tự vào Vault. Xoá key ở đây thì bot dùng provider đó sẽ cần nhập lại key.",
"settings.vaultDelete": "Xoá",
"settings.vaultDeleteConfirm": "Xoá secret “{key}” khỏi Vault?",
"settings.usageTitle": "Mức sử dụng & giới hạn chi tiêu",
"settings.usageToday": "Hôm nay: {cost} · {tokens} token",
"settings.usageMonth": "Tháng này: {cost} · {tokens} token",
"settings.usageUnknown": "chưa rõ (có model chưa có giá)",
"settings.usageDailyLimit": "Đã dùng {percent}% giới hạn ngày (${limit}).",
"settings.usageUnpriced": "{count} lượt gọi dùng model chưa có giá nên tiền hiển thị có thể thấp hơn thực tế.",
"settings.limitsTitle": "Giới hạn chi tiêu (USD)",
"settings.limitsDailyLabel": "Giới hạn ngày",
"settings.limitsMonthlyLabel": "Giới hạn tháng",
"settings.limitsHint": "Để trống = không giới hạn. Vượt giới hạn thì bot dừng gọi provider cho tới khi sang ngày/tháng mới hoặc bạn nâng giới hạn.",
"settings.limitsSave": "Lưu giới hạn",
"settings.usageResetTitle": "Xoá lịch sử sử dụng",
"settings.usageResetConfirm": "Xoá lịch sử sử dụng đã chọn? Giới hạn chi tiêu vẫn giữ nguyên.",
"settings.usageResetDay": "Xoá hôm nay",
"settings.usageResetMonth": "Xoá tháng này",
"settings.usageResetAll": "Xoá tất cả"
```

**en.json:**

```json
"settings.vaultTitle": "Secret vault",
"settings.vaultIntro": "API keys and credentials are encrypted and stored separately from settings; values are never shown again.",
"settings.vaultEmpty": "No secrets in the vault yet.",
"settings.vaultHint": "Provider keys entered below go into the vault automatically. Deleting a key here means bots using that provider will need the key again.",
"settings.vaultDelete": "Delete",
"settings.vaultDeleteConfirm": "Delete secret “{key}” from the vault?",
"settings.usageTitle": "Usage & spend limits",
"settings.usageToday": "Today: {cost} · {tokens} tokens",
"settings.usageMonth": "This month: {cost} · {tokens} tokens",
"settings.usageUnknown": "unknown (some model has no price)",
"settings.usageDailyLimit": "Used {percent}% of the daily limit (${limit}).",
"settings.usageUnpriced": "{count} calls used a model without a price, so the shown cost may be lower than the real spend.",
"settings.limitsTitle": "Spend limits (USD)",
"settings.limitsDailyLabel": "Daily limit",
"settings.limitsMonthlyLabel": "Monthly limit",
"settings.limitsHint": "Leave empty for no limit. When a limit is exceeded the bot stops calling the provider until a new day/month starts or you raise the limit.",
"settings.limitsSave": "Save limits",
"settings.usageResetTitle": "Clear usage history",
"settings.usageResetConfirm": "Clear the selected usage history? Spend limits stay as they are.",
"settings.usageResetDay": "Clear today",
"settings.usageResetMonth": "Clear this month",
"settings.usageResetAll": "Clear all"
```

Chạy `node --test tests/i18n.test.mjs` sau khi thêm key để kiểm tra
vi/en đủ key (test hiện có kiểm tra locale parity).

---

## 7. Thứ tự thực hiện (đề xuất cho điều phối viên)

1. **§2** — export core + build core + chạy `tests/vault.test.mjs`
   + `tests/usage.test.mjs` (phải xanh trước khi nối UI).
2. **§3.1–3.2** — init Vault/Usage + migration key; chạy app, kiểm tra
   `vault.json` được tạo, key cũ biến khỏi `settings.json`, bot cũ
   vẫn chat được (key đọc từ Vault).
3. **§3.3 + §3.5** — `providerConfigFor` + `settings:set` đọc/ghi Vault.
4. **§3.6** — MeteredProvider trong coordinator + `usageStorePath`;
   test bằng mock provider + limit $0.01: chat phải trả lỗi
   `Spend limit exceeded...`, `usage.json` ghi nhận call khi chưa vượt.
5. **§3.4 + §4** — IPC + preload.
6. **§5 + §6** — SettingsView (Vault + Usage banner + form limit) +
   i18n vi/en; chạy `tests/i18n.test.mjs`.
7. Kiểm thử cuối: đặt limit ngày $0.01 → chat 1 lần (Ollama local
   không tốn tiền nên không bị chặn — dùng mock/Grok để thấy chặn) →
   banner hiện % giới hạn → nâng limit → chat lại được → reset ngày →
   banner về 0.

## 8. Giới hạn còn tồn đọng (worker 1 đã biết, chưa xử lý)

- **LocalEncryptor là fallback, không phải đích cuối:** key file nằm
  trên cùng máy nên ai đọc được file là đọc được Vault. Đích cuối là
  `safeStorage` (§3.1 đã ưu tiên safeStorage, fallback chỉ khi OS
  không có backend). Trên Linux không có libsecret thì vẫn dùng fallback.
- **Không có NO_STORAGE mode:** Grok Bot có chế độ riêng tư không lưu
  token bền; Vault hiện luôn lưu bền. Muốn thêm thì thêm option
  `Vault({ noStorage: true })` + không gọi `setSecret` — việc của mốc sau.
- **Race ghi `usage.json` giữa main và coordinator:** `reload()` trước
  mỗi check (§3.3) thu hẹp cửa sổ race, nhưng hai tiến trình ghi cùng
  lúc vẫn có thể mất một record (last-writer-wins). Chấp nhận được ở
  local single-user; muốn chắc chắn thì chuyển usage sang SQLite hoặc
  dồn mọi ghi qua coordinator RPC ở mốc sau.
- **Spend limit là ước tính, không phải hoá đơn:** giá trong bảng có
  thể lỗi thời; long-context / cached-input / batch / priority tính
  theo giá chuẩn. Người dùng tự chịu chênh lệch với bill thật của provider.
- **Chưa có UI banner ở ChatView:** banner hiện chỉ ở Settings (§5.2).
  Muốn banner luôn hiện thì App.tsx cần gọi `getUsage()` sau mỗi lần
  chat xong — để dành cho worker UI.
- **Vault chưa nối vào MCP/plugin:** `mcp.json` và plugin vẫn đọc
  credential theo cách cũ. Worker tích hợp MCP/plugin tự lấy secret
  qua `vault.getSecret('mcp', serverId)` / `('plugin', pluginId)` khi
  cần — API đã sẵn.
- **Chưa có test e2e Electron:** test hiện tại chỉ ở tầng core
  (node:test + mock provider). Luồng IPC + migration cần kiểm thử tay
  theo §7 bước 2–4, 7.
