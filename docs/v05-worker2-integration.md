# Đặc tả tích hợp v0.5 — Local API + Webhook (worker 2)

> Tài liệu này dành cho **điều phối viên**: áp dụng các thay đổi dưới đây
> vào `apps/desktop` (main / preload / renderer) và `packages/core`
> (export). Mọi code mẫu đã viết sẵn để dán vào — không viết chung
> chung. Code lõi (Local API server, WebhookDispatcher) đã xong và đã
> có test, xem §1.
>
> **Không sửa trong đợt này:** `docs/ROADMAP.md` (điều phối viên tự tick
> checklist sau khi nối xong), `packages/tools/*`,
> `packages/core/src/coordinator/*`, `packages/core/src/vault/*`.
>
> **Lưu ý về cây làm việc hiện tại:** một worker v0.5 song song đã thêm
> sẵn phía renderer — kiểu `ApiStatusView` / `WebhookView` trong
> `apps/desktop/src/renderer/types.ts`, các method `'api:*'` trong
> `apps/desktop/src/renderer/global.d.ts`, chuỗi `settings.api*` trong
> cả hai locale `vi.json` / `en.json`, và mục API trong
> `apps/desktop/src/renderer/components/SettingsView.tsx` (dùng
> `window.openBot` qua fallback `Record<string, unknown>`, xem §5).
> Điều phối viên chỉ cần **đối chiếu** các phần đó với bản đặc tả này
> (đặc biệt là tên channel IPC ở §3.4 và hình dạng dữ liệu ở §5.3),
> không viết lại từ đầu; nếu có lệch thì sửa phía renderer cho khớp
> channel ở §3.4, không sửa tên channel.

## 1. Cái đã có sẵn (worker 2 đã làm, đã test)

| Hạng mục | File | Export chính |
|---|---|---|
| Local API server | `packages/core/src/api/server.ts` | `createApiServer`, `MAX_JSON_BODY_BYTES`, `DEFAULT_HISTORY_LIMIT`, `MAX_HISTORY_LIMIT`; type `LocalApiServer` |
| Webhook dispatcher | `packages/core/src/api/webhooks.ts` | `WebhookDispatcher`, `WEBHOOK_TIMEOUT_MS`, `WEBHOOK_EVENT_KINDS` |
| Types chung | `packages/core/src/api/types.ts` | `ApiBotSummary`, `ApiRunRecord`, `ApiHandlers`, `CreateApiServerOptions`, `WebhookEvent`, `WebhookEventKind`, `WebhookRegistration`, `WebhookDispatchResult`, `WebhookDispatcherOptions` |
| Barrel | `packages/core/src/api/index.ts` | Re-export toàn bộ module `api` |
| Test | `tests/api.test.mjs` | 13 test, chạy bằng `node --test tests/api.test.mjs` sau khi build core |

### 1.1. API Local API server (đã có, không cần viết lại)

```ts
import { createApiServer } from '@open-bot/core';

const server = createApiServer({
  port: 3456,                 // 0 = OS chọn port trống (chỉ dùng cho test)
  token: '<token từ Vault>',  // xem §3.1 — KHÔNG hard-code, KHÔNG log
  handlers: {
    listBots: () => settings.bots.map((b) => ({
      id: b.id, name: b.name, providerId: b.providerId, model: b.model,
    })),
    runBot: async (botId, text) => ({ text: await runOneTurn(botId, text) }),
    getHistory: (botId, limit) => historyFromMemory(runtime, limit),
    listTasks: (botId) => /* như handler 'tasks:list' hiện có */,
  },
  // Móc webhook: gọi khi một run nền kết thúc (xem §3.3).
  onRunSettled: (run) => { /* dispatch run.done / run.error */ },
});
await server.start();   // throw lỗi rõ ràng khi port bận (EADDRINUSE)
await server.stop();    // đóng server + huỷ mọi kết nối keep-alive
server.port;            // port thực tế đã bind
server.isRunning;       // boolean
server.getRun(runId);   // ApiRunRecord | undefined (bản copy)
server.listRuns();      // ApiRunRecord[] (bản copy)
```

Routes (server chỉ bind `127.0.0.1` — loopback, không bao giờ `0.0.0.0`):

| Route | Auth | Trả về |
|---|---|---|
| `GET /v1/health` | Không cần | `{ ok: true }` |
| `GET /v1/bots` | Bearer | `ApiBotSummary[]` — `{ id, name, providerId, model }` |
| `POST /v1/bots/:id/run` `{ "text": "..." }` | Bearer | `202 { runId, status: 'running' }` — chạy nền, không block request |
| `GET /v1/runs/:id` | Bearer | `{ runId, botId, status: 'running'\|'done'\|'error', text?, error?, startedAt, finishedAt? }` |
| `GET /v1/bots/:id/history?limit=N` | Bearer | Lịch sử chat (mặc định 50, tối đa 200) |
| `GET /v1/bots/:id/tasks` | Bearer | Tracked task của bot |

Lỗi: thiếu/sai token → `401 { error }`; bot/run không có → `404 { error }`;
JSON sai / body > 1 MB / `text` rỗng / `limit` không hợp lệ → `400 { error }`.
Token được so sánh bằng `===` (ghi rõ trong comment ở `server.ts`):
chấp nhận được ở v0.5 **chỉ vì** server bind loopback cho chủ máy dùng
local; nếu bao giờ mở ra ngoài loopback thì phải đổi sang
`crypto.timingSafeEqual` + rate limiting trước.

### 1.2. API WebhookDispatcher (đã có, không cần viết lại)

```ts
import { WebhookDispatcher } from '@open-bot/core';

const webhooks = new WebhookDispatcher({
  storePath: path.join(app.getPath('userData'), 'webhooks.json'),
});
const reg = webhooks.add('https://example.com/hook', ['run.done', 'run.error']);
// -> { id, url, events } — throw khi URL không phải http(s), events rỗng,
//    hoặc có kind lạ. id sinh bằng randomUUID.
webhooks.list();            // WebhookRegistration[] (bản copy)
webhooks.remove(reg.id);    // boolean

const results = await webhooks.dispatch({
  kind: 'run.done',
  at: new Date().toISOString(),
  data: { botId, runId, text },
});
// results: [{ webhookId, url, ok, status?, error? }] — best-effort:
// endpoint chết / timeout 5s / non-2xx chỉ ghi vào kết quả, KHÔNG throw.
```

Event kinds: `'run.done' | 'run.error' | 'approval.needed' | 'automation.notify'`.
Payload `data` theo kind (xem §3.3). **Giới hạn v0.5 (cố ý): webhook
KHÔNG ký signature** — receiver chưa thể xác thực POST có phải từ
open-bot không; chấp nhận được khi webhook trỏ tới localhost/dịch vụ
tin cậy, nhưng trước khi gửi tới URL công khai thì mốc sau phải thêm
header HMAC (vd: `X-Open-Bot-Signature: sha256=...` trên raw body,
secret = API token). Ghi chú này đã có trong comment ở `webhooks.ts`.

---

## 2. Bước 0 — export từ `@open-bot/core` (bắt buộc trước mọi bước khác)

Worker 2 **không được sửa** `packages/core/src/index.ts`, nên API /
webhook hiện chỉ import được qua deep path
(`@open-bot/core/dist/api/index.js` trong test). Điều phối viên thêm
vào cuối `packages/core/src/index.ts` (giữ đúng thứ tự nhóm export
hiện có, sau nhóm Performance v0.4):

```ts
// --- v0.5: Local API + webhooks ---
export { createApiServer, MAX_JSON_BODY_BYTES, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT } from './api/index';
export type { LocalApiServer } from './api/index';
export { WebhookDispatcher, WEBHOOK_TIMEOUT_MS, WEBHOOK_EVENT_KINDS } from './api/index';
export type {
  ApiBotSummary,
  ApiHandlers,
  ApiRunRecord,
  CreateApiServerOptions,
  WebhookDispatchResult,
  WebhookDispatcherOptions,
  WebhookEvent,
  WebhookEventKind,
  WebhookRegistration,
} from './api/index';
```

Sau đó chạy `npm run build --workspace=@open-bot/core` rồi
`node --test tests/api.test.mjs` để xác nhận (13 test phải xanh trước
khi nối UI).

---

## 3. Main process — `apps/desktop/src/main/main.ts`

### 3.1. Cấu hình API trong settings + token trong Vault

Thêm field vào `AppSettings` (cạnh `dream?`):

```ts
export interface ApiSettings {
  /** Bật/tắt Local API. Mặc định tắt. */
  enabled: boolean;
  /** Port bind loopback. Mặc định 3456. */
  port: number;
}

export interface AppSettings {
  providers: Record<string, ProviderSettings>;
  bots: BotConfig[];
  locale: AppLocale;
  dream?: DreamConfig;
  /** v0.5: cấu hình Local API (chỉ enabled + port; token ở Vault). */
  api?: ApiSettings;
}
```

`loadSettings()` phải hợp nhất giá trị mặc định khi file cũ chưa có
mục này, và `saveSettings()` giữ nguyên (ghi cả mục `api`):

```ts
// Trong loadSettings(), object trả về thêm:
api: {
  enabled: parsed.api?.enabled === true,
  port: typeof parsed.api?.port === 'number' && parsed.api.port >= 1024
    && parsed.api.port <= 65535 ? parsed.api.port : 3456,
},
// Và trong nhánh catch (file chưa có / hỏng):
return { providers: defaultProviderSettings(), bots: [], locale: 'vi', api: { enabled: false, port: 3456 } };
```

Token API — **sinh ngẫu nhiên 32 byte hex, lưu Vault namespace `'api'`
key `'token'`, KHÔNG bao giờ log token** (kể cả một phần):

```ts
import { randomBytes } from 'node:crypto';

const API_TOKEN_NAMESPACE = 'api';
const API_TOKEN_KEY = 'token';

/**
 * Lấy token API từ Vault, sinh mới khi chưa có. Token là 32 byte
 * ngẫu nhiên (hex, 64 ký tự). KHÔNG log giá trị token ở bất kỳ đâu.
 */
function getOrCreateApiToken(): string {
  const existing = vault.getSecret(API_TOKEN_NAMESPACE, API_TOKEN_KEY);
  if (existing) return existing;
  const token = randomBytes(32).toString('hex');
  vault.setSecret(API_TOKEN_NAMESPACE, API_TOKEN_KEY, token);
  return token;
}
```

### 3.2. Khởi động / dừng server (đặt cạnh `initAutomations`)

```ts
import {
  createApiServer,
  WebhookDispatcher,
  type LocalApiServer,
} from '@open-bot/core';

const API_FILE = 'webhooks.json';
const DEFAULT_API_PORT = 3456;

let apiServer: LocalApiServer | null = null;
let webhookDispatcher: WebhookDispatcher | null = null;
/** Trạng thái API hiện tại (đọc bởi 'api:get'). */
let apiConfig: ApiSettings = { enabled: false, port: DEFAULT_API_PORT };

function getWebhookDispatcher(): WebhookDispatcher {
  if (!webhookDispatcher) {
    webhookDispatcher = new WebhookDispatcher({
      storePath: path.join(app.getPath('userData'), API_FILE),
    });
  }
  return webhookDispatcher;
}

/**
 * Khởi động Local API khi bật trong Settings; dừng khi tắt hoặc khi
 * đổi port (stop rồi start lại với port mới). Lỗi port bận được trả
 * về cho renderer dưới dạng message (không crash app).
 */
async function applyApiConfig(next: ApiSettings): Promise<ApiSettings> {
  apiConfig = {
    enabled: next.enabled === true,
    port: typeof next.port === 'number' && next.port >= 1024 && next.port <= 65535
      ? next.port : DEFAULT_API_PORT,
  };
  settings.api = { ...apiConfig };
  saveSettings();
  await stopApiServer();
  if (apiConfig.enabled) {
    await startApiServer();
  }
  return { ...apiConfig };
}

async function startApiServer(): Promise<void> {
  const token = getOrCreateApiToken(); // KHÔNG log token
  apiServer = createApiServer({
    port: apiConfig.port,
    token,
    handlers: buildApiHandlers(),
    onRunSettled: (run) => {
      // Run nền của API xong -> webhook run.done / run.error.
      void dispatchRunWebhook(run);
    },
  });
  await apiServer.start();
  console.log(`[open-bot] Local API đang chạy ở http://127.0.0.1:${apiServer.port}/v1`);
}

async function stopApiServer(): Promise<void> {
  if (!apiServer) return;
  const srv = apiServer;
  apiServer = null;
  await srv.stop();
}
```

Gọi trong `app.whenReady()`, **sau** `initVaultAndUsage()` (token cần
Vault) và sau khi `settings` đã load — đặt ngay sau `initAutomations()`:

```ts
apiConfig = settings.api ?? { enabled: false, port: DEFAULT_API_PORT };
if (apiConfig.enabled) {
  // Bật từ lần chạy trước: khởi động lại server; port bận thì chỉ log
  // lỗi, app vẫn mở bình thường để người dùng đổi port trong Settings.
  await startApiServer().catch((err: unknown) => {
    console.error('[open-bot] Không khởi động được Local API:', (err as Error).message);
  });
}
```

Và dừng ở `app.on('before-quit')`, cạnh `automationScheduler?.stop()`:

```ts
void stopApiServer().catch(() => undefined);
```

### 3.3. Handlers cho server + móc webhook dispatch

`buildApiHandlers()` tái sử dụng đúng đường đi của `chat:send`
(coordinator + WorkerPool) để run qua API và run qua UI cho cùng một
kết quả; `getHistory`/`listTasks` tái sử dụng `historyFromMemory` và
logic map status trong handler `'tasks:list'` hiện có:

```ts
function buildApiHandlers(): ApiHandlers {
  return {
    listBots: () =>
      settings.bots.map((b) => ({
        id: b.id, name: b.name, providerId: b.providerId, model: b.model,
      })),
    runBot: async (botId, text) => {
      const bot = settings.bots.find((b) => b.id === botId);
      if (!bot) throw new Error('Không tìm thấy bot.');
      await getOrCreateRuntime(bot);
      activeChatRuns.add(bot.id);
      dreamEngine?.noteActivity(bot.id);
      try {
        const result = await workerPool.submit(
          () => getCoordinator().run(bot.id, text),
          { label: `api:${bot.id}` },
        ).promise;
        return { text: result.text ?? '' };
      } finally {
        activeChatRuns.delete(bot.id);
        dreamEngine?.noteActivity(bot.id);
      }
    },
    getHistory: async (botId, limit) => {
      const bot = settings.bots.find((b) => b.id === botId);
      if (!bot) throw new Error('Không tìm thấy bot.');
      const runtime = await getOrCreateRuntime(bot);
      return historyFromMemory(runtime, limit);
    },
    listTasks: async (botId) => {
      const bot = settings.bots.find((b) => b.id === botId);
      if (!bot) throw new Error('Không tìm thấy bot.');
      const runtime = await getOrCreateRuntime(bot);
      try {
        const { tasks } = await getCoordinator().listTasks(bot.id);
        return tasks.map((task) => ({
          id: task.id,
          botId: task.botId,
          title: task.title,
          status:
            task.status === 'in_progress' ? 'running'
            : task.status === 'cancelled' ? 'failed'
            : task.status,
        }));
      } catch {
        return runtime.tasks;
      }
    },
  };
}

/** Fire-and-forget: lỗi webhook không bao giờ làm hỏng run. */
async function dispatchRunWebhook(run: ApiRunRecord): Promise<void> {
  try {
    await getWebhookDispatcher().dispatch({
      kind: run.status === 'done' ? 'run.done' : 'run.error',
      at: new Date().toISOString(),
      data: run.status === 'done'
        ? { botId: run.botId, runId: run.runId, text: run.text ?? '' }
        : { botId: run.botId, runId: run.runId, error: run.error ?? 'Run failed.' },
    });
  } catch {
    // dispatch() vốn đã best-effort; đây chỉ là lưới an toàn cuối.
  }
}
```

**Móc webhook vào `chat:send` (finally: run done/error).** Trong handler
`'chat:send'` hiện có, theo dõi thêm lỗi rồi dispatch ở `finally`
(cạnh `automationScheduler?.notifyEvent(event)` đã có):

```ts
// Đầu handler 'chat:send', cạnh `let replyText = '';`:
let runError: string | null = null;
// Trong catch hiện có, sau khi tính `message`:
runError = message;
// Trong finally hiện có, sau notifyEvent của automation:
void getWebhookDispatcher().dispatch({
  kind: runError ? 'run.error' : 'run.done',
  at: new Date().toISOString(),
  data: runError
    ? { botId: bot.id, error: runError }
    : { botId: bot.id, text: replyText },
}).catch(() => undefined);
```

**Móc `approval.needed` vào `routeCoordinatorEvent`.** Trong case
`'approval-needed'` hiện có, thêm sau `sendToRenderer(...)`:

```ts
void getWebhookDispatcher().dispatch({
  kind: 'approval.needed',
  at: new Date().toISOString(),
  data: { botId, callId: payload.callId, call: payload.call },
}).catch(() => undefined);
```

**Móc `automation.notify`.** Trong `buildAutomationHandlers()`,
handler `notify` hiện gửi về renderer; thêm dispatch cạnh đó:

```ts
notify: (message) => {
  sendToRenderer('automation:notify', { message, at: Date.now() });
  void getWebhookDispatcher().dispatch({
    kind: 'automation.notify',
    at: new Date().toISOString(),
    data: { message },
  }).catch(() => undefined);
},
```

### 3.4. IPC handlers mới — đặt trong `registerIpc()`, sau nhóm `settings:*`

Tên channel phải **đúng y hệt** dưới đây (renderer đã gọi đúng các tên
này, xem §5; đổi tên là gãy UI):

```ts
// --- v0.5: Local API + webhooks ---
ipcMain.handle('api:get', () => ({
  enabled: apiConfig.enabled,
  port: apiConfig.port,
  tokenSet: vault.hasSecret(API_TOKEN_NAMESPACE, API_TOKEN_KEY),
}));

ipcMain.handle('api:set', async (_event: unknown, patch: { enabled?: boolean; port?: number }) => {
  const next = await applyApiConfig({
    enabled: patch.enabled ?? apiConfig.enabled,
    port: patch.port ?? apiConfig.port,
  });
  return {
    enabled: next.enabled,
    port: next.port,
    tokenSet: vault.hasSecret(API_TOKEN_NAMESPACE, API_TOKEN_KEY),
  };
});

// Token chỉ trả về khi người dùng bấm "Hiện token" — renderer không
// tự gọi channel này lúc load trang. KHÔNG log token.
ipcMain.handle('api:get-token', () => ({ token: getOrCreateApiToken() }));

ipcMain.handle('api:regenerate-token', async () => {
  const token = randomBytes(32).toString('hex');
  vault.setSecret(API_TOKEN_NAMESPACE, API_TOKEN_KEY, token);
  // Server đang chạy giữ token cũ trong closure -> khởi động lại để
  // token mới có hiệu lực ngay; token cũ mất hiệu lực tức thì.
  if (apiServer) {
    await stopApiServer();
    await startApiServer();
  }
  return { token };
});

ipcMain.handle('api:webhooks-list', () => getWebhookDispatcher().list());

ipcMain.handle(
  'api:webhooks-add',
  (_event: unknown, payload: { url: string; events: string[] }) => {
    // WebhookDispatcher.add throw khi URL/events không hợp lệ;
    // renderer bắt lỗi và hiện settings.apiWebhookAddError.
    return getWebhookDispatcher().add(payload.url, payload.events);
  },
);

ipcMain.handle('api:webhooks-remove', (_event: unknown, payload: { id: string }) => {
  return getWebhookDispatcher().remove(payload.id);
});
```

---

## 4. Preload — `apps/desktop/src/main/preload.ts`

Thêm vào `OpenBotApi` (sau nhóm `settings:*`, theo đúng pattern hiện
có). Lưu ý: `global.d.ts` phía renderer đã khai báo sẵn các method này
dưới dạng tên có dấu hai chấm (xem §5) — preload phải expose **đúng
các tên đó**:

```ts
// v0.5: Local API + webhooks (method names are the IPC channel names).
'api:get'(): Promise<ApiStatusView>;
'api:set'(patch: { enabled?: boolean; port?: number }): Promise<ApiStatusView>;
'api:get-token'(): Promise<{ token: string | null }>;
'api:regenerate-token'(): Promise<{ token: string }>;
'api:webhooks-list'(): Promise<WebhookView[]>;
'api:webhooks-add'(payload: { url: string; events: string[] }): Promise<WebhookView>;
'api:webhooks-remove'(id: string): Promise<boolean>;
```

Và vào object `openBot` (dùng key có dấu ngoặc kép vì tên chứa `:`):

```ts
'api:get': () => ipcRenderer.invoke('api:get'),
'api:set': (patch) => ipcRenderer.invoke('api:set', patch),
'api:get-token': () => ipcRenderer.invoke('api:get-token'),
'api:regenerate-token': () => ipcRenderer.invoke('api:regenerate-token'),
'api:webhooks-list': () => ipcRenderer.invoke('api:webhooks-list'),
'api:webhooks-add': (payload) => ipcRenderer.invoke('api:webhooks-add', payload),
'api:webhooks-remove': (id) => ipcRenderer.invoke('api:webhooks-remove', id),
```

Các kiểu `ApiStatusView` / `WebhookView` import từ `./types` (renderer)
hoặc khai báo inline trong `preload.ts` theo pattern các type
v0.4 đã có; hình dạng dữ liệu xem §5.3.

---

## 5. Renderer — `SettingsView.tsx`

### 5.1. Trạng thái hiện tại (đã có trong cây làm việc — chỉ đối chiếu)

Worker song song đã thêm mục API vào `SettingsView.tsx` với state
`apiStatus` / `apiPort` / `apiToken` / webhook list, gọi API qua
fallback `window.openBot` dạng `Record<string, unknown>` (channel
`'api:get'` … `'api:webhooks-remove'`). Điều phối viên kiểm tra các
điểm sau thay vì viết lại:

- Bật/tắt gọi `'api:set'` với `{ enabled, port }`; đổi port rồi bấm
  Lưu mới áp dụng (server restart theo §3.2).
- Nút "Hiện token" gọi `'api:get-token'` **chỉ khi người dùng bấm**;
  token hiện trong ô chỉ-đọc + nút Copy (`navigator.clipboard`) +
  nút Ẩn; **không** gọi `'api:get-token'` lúc load trang.
- Nút "Tạo token mới" hỏi confirm (`settings.apiRegenerateConfirm`)
  rồi gọi `'api:regenerate-token'`; token mới hiện một lần để người
  dùng copy, token cũ mất hiệu lực ngay.
- Danh sách webhook: mỗi dòng hiện URL + các event đã đăng ký + nút
  Xoá (confirm `settings.apiWebhookDeleteConfirm`); form thêm gồm ô
  URL (`settings.apiWebhookUrlPlaceholder`) + 4 checkbox event
  (`run.done`, `run.error`, `approval.needed`, `automation.notify`)
  + nút Thêm; lỗi thêm hiện `settings.apiWebhookAddError`.
- `api:get` lỗi (main chưa có IPC) → hiện `settings.apiLoadError`,
  các mục khác của Settings vẫn dùng được (load API là best-effort,
  như các mục v0.4).

### 5.2. Code mẫu mục API trong SettingsView (để đối chiếu / bổ sung nếu thiếu)

```tsx
const [apiStatus, setApiStatus] = useState<ApiStatusView | null>(null);
const [apiPort, setApiPort] = useState(0);
const [apiToken, setApiToken] = useState<string | null>(null);
const [apiError, setApiError] = useState('');
const [apiSaved, setApiSaved] = useState(false);
const [webhooks, setWebhooks] = useState<WebhookView[]>([]);
const [webhookUrl, setWebhookUrl] = useState('');
const [webhookEvents, setWebhookEvents] = useState<string[]>(['run.done']);

// Load (best-effort, trong useEffect loadExtras hiện có):
try {
  const s = await window.openBot['api:get']();
  setApiStatus(s);
  setApiPort(s.port);
} catch { setApiError(t('settings.apiLoadError')); }
try { setWebhooks(await window.openBot['api:webhooks-list']()); } catch { /* ignore */ }

const saveApi = async () => {
  setApiError('');
  try {
    const next = await window.openBot['api:set']({ enabled: apiStatus?.enabled ?? false, port: apiPort });
    setApiStatus(next);
    setApiSaved(true);
  } catch { setApiError(t('settings.apiSaveError')); }
};

const showToken = async () => {
  const { token } = await window.openBot['api:get-token']();
  setApiToken(token);
};

const regenerateToken = async () => {
  if (!window.confirm(t('settings.apiRegenerateConfirm'))) return;
  const { token } = await window.openBot['api:regenerate-token']();
  setApiToken(token);
};

const addWebhook = async () => {
  try {
    const added = await window.openBot['api:webhooks-add']({ url: webhookUrl, events: webhookEvents });
    setWebhooks((prev) => [...prev, added]);
    setWebhookUrl('');
  } catch { setApiError(t('settings.apiWebhookAddError')); }
};

const removeWebhook = async (id: string) => {
  if (!window.confirm(t('settings.apiWebhookDeleteConfirm'))) return;
  await window.openBot['api:webhooks-remove'](id);
  setWebhooks((prev) => prev.filter((w) => w.id !== id));
};
```

Section JSX (đặt sau section Vault, trước danh sách provider):

```tsx
<section className="card">
  <h3>{t('settings.apiTitle')}</h3>
  <p className="hint">{t('settings.apiIntro')}</p>
  {apiError && <p className="error">{apiError}</p>}
  {apiSaved && <p className="success">{t('settings.apiSaved')}</p>}
  <label>
    <input
      type="checkbox"
      checked={apiStatus?.enabled ?? false}
      onChange={(e) => setApiStatus((prev) => ({ ...(prev ?? { port: apiPort, tokenSet: false }), enabled: e.target.checked }))}
    />
    {t('settings.apiEnabledLabel')}
  </label>
  <div className="field">
    <label htmlFor="api-port">{t('settings.apiPortLabel')}</label>
    <input id="api-port" type="number" min={1024} max={65535} value={apiPort}
      onChange={(e) => setApiPort(Number(e.target.value) || 3456)} />
  </div>
  <button className="btn secondary" onClick={() => void saveApi()}>{t('settings.apiSave')}</button>

  <h4>{t('settings.apiTokenTitle')}</h4>
  <p>{apiStatus?.tokenSet ? t('settings.apiTokenSet') : t('settings.apiTokenNotSet')}</p>
  {apiToken !== null && (
    <div className="field">
      <label>{t('settings.apiTokenLabel')}</label>
      <input type="text" readOnly value={apiToken} />
      <div className="row">
        <button className="btn secondary" onClick={() => void navigator.clipboard.writeText(apiToken)}>
          {t('settings.apiCopyToken')}
        </button>
        <button className="btn secondary" onClick={() => setApiToken(null)}>{t('settings.apiHideToken')}</button>
      </div>
    </div>
  )}
  <div className="row">
    {apiToken === null && (
      <button className="btn secondary" onClick={() => void showToken()}>{t('settings.apiShowToken')}</button>
    )}
    <button className="btn secondary" onClick={() => void regenerateToken()}>{t('settings.apiRegenerateToken')}</button>
  </div>

  <h4>{t('settings.apiWebhooksTitle')}</h4>
  {webhooks.length === 0 && <p>{t('settings.apiWebhooksEmpty')}</p>}
  <ul>
    {webhooks.map((w) => (
      <li key={w.id}>
        {w.url} — {w.events.join(', ')}{' '}
        <button className="btn secondary" onClick={() => void removeWebhook(w.id)}>
          {t('settings.apiWebhookDelete')}
        </button>
      </li>
    ))}
  </ul>
  {/* Form thêm webhook: ô URL + 4 checkbox event + nút settings.apiWebhookAdd */}
</section>
```

### 5.3. Kiểu dữ liệu renderer — `apps/desktop/src/renderer/types.ts`

Đã có sẵn trong cây làm việc (đối chiếu, không thêm lại nếu đã đúng):

```ts
/** Local API status (v0.5). */
export interface ApiStatusView {
  enabled: boolean;
  port: number;
  tokenSet: boolean;
}

/** One webhook subscription (v0.5). */
export interface WebhookView {
  id: string;
  url: string;
  events: string[];
}
```

---

## 6. i18n — thêm vào `vi.json` và `en.json`

Các key sau **đã có sẵn trong cả hai locale** ở cây làm việc hiện
tại (worker song song đã thêm); điều phối viên chỉ đối chiếu đủ key
rồi chạy `node --test tests/i18n.test.mjs` để kiểm tra parity vi/en:

**vi.json / en.json:**

```json
"settings.apiTitle": "API local cho bên thứ ba" / "Local API for third parties",
"settings.apiIntro": "Bật API local để app hoặc script ngoài gọi được agent qua HTTP. Token chỉ hiện khi bạn yêu cầu." / "Enable the local API so outside apps or scripts can call the agent over HTTP. The token is only shown when you ask for it.",
"settings.apiEnabledLabel": "Bật API local" / "Enable local API",
"settings.apiPortLabel": "Cổng (port)" / "Port",
"settings.apiSave": "Lưu API" / "Save API",
"settings.apiSaved": "Đã lưu cài đặt API." / "API settings saved.",
"settings.apiSaveError": "Không lưu được cài đặt API." / "Could not save the API settings.",
"settings.apiLoadError": "Không tải được trạng thái API." / "Could not load the API status.",
"settings.apiTokenTitle": "Token API" / "API token",
"settings.apiTokenLabel": "Token" / "Token",
"settings.apiTokenSet": "Đã có token." / "A token is set.",
"settings.apiTokenNotSet": "Chưa có token." / "No token yet.",
"settings.apiShowToken": "Hiện token" / "Show token",
"settings.apiHideToken": "Ẩn token" / "Hide token",
"settings.apiCopyToken": "Sao chép token" / "Copy token",
"settings.apiCopied": "Đã sao chép." / "Copied.",
"settings.apiRegenerateToken": "Tạo token mới" / "Regenerate token",
"settings.apiRegenerateConfirm": "Tạo token mới? Token cũ sẽ không dùng được nữa." / "Regenerate the token? The old token will stop working.",
"settings.apiWebhooksTitle": "Webhook" / "Webhooks",
"settings.apiWebhooksEmpty": "Chưa có webhook nào." / "No webhooks yet.",
"settings.apiWebhookUrlLabel": "URL webhook" / "Webhook URL",
"settings.apiWebhookUrlPlaceholder": "https://example.com/hook",
"settings.apiWebhookEventsLabel": "Sự kiện" / "Events",
"settings.apiWebhookAdd": "Thêm webhook" / "Add webhook",
"settings.apiWebhookAddError": "Không thêm được webhook. Kiểm tra lại URL và chọn ít nhất một sự kiện." / "Could not add the webhook. Check the URL and pick at least one event.",
"settings.apiWebhookDelete": "Xoá" / "Delete",
"settings.apiWebhookDeleteConfirm": "Xoá webhook này?" / "Delete this webhook?",
"settings.apiEventRunDone": "Agent xong việc (run.done)" / "Agent finished (run.done)",
"settings.apiEventRunError": "Agent gặp lỗi (run.error)" / "Agent errored (run.error)",
"settings.apiEventApprovalNeeded": "Cần phê duyệt (approval.needed)" / "Approval needed (approval.needed)",
"settings.apiEventAutomationNotify": "Thông báo automation (automation.notify)" / "Automation notification (automation.notify)"
```

---

## 7. Kiểm thử cuối (cho điều phối viên)

1. **§2** — export core + build core + `node --test tests/api.test.mjs`
   (13 test xanh).
2. **API bằng curl** (app đang chạy, API đã bật ở Settings, port 3456):
   ```bash
   TOKEN=$(...)  # lấy bằng nút "Hiện token" trong Settings, không đọc vault.json
   curl http://127.0.0.1:3456/v1/health
   # -> {"ok":true} (không cần token)
   curl http://127.0.0.1:3456/v1/bots
   # -> 401 (thiếu token)
   curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3456/v1/bots
   # -> [{id, name, providerId, model}]
   curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"text":"chào bot"}' http://127.0.0.1:3456/v1/bots/<BOT_ID>/run
   # -> 202 {"runId":"...","status":"running"}
   curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3456/v1/runs/<RUN_ID>
   # -> poll tới {"status":"done","text":"..."} (Ollama local qwen2.5:0.5b
   #    chạy được không cần key thật; provider cloud chưa có key thì run
   #    trả status "error" với message rõ ràng, không crash server)
   ```
3. **Webhook bằng mock server local:** chạy `nc -l 127.0.0.1 18080` hoặc
   một HTTP server nhỏ, đăng ký webhook `http://127.0.0.1:18080/hook`
   với event `run.done` trong Settings, chat một câu trong app → server
   nhận được POST JSON `{ kind: 'run.done', at, data: { botId, text } }`.
   Tắt mock server rồi chat tiếp → app vẫn chạy, không crash (dispatch
   best-effort).
4. **Token:** bấm "Tạo token mới" → token cũ gọi API trả 401 ngay;
   token mới gọi được. Kiểm tra `vault.json` chỉ chứa ciphertext
   (không thấy token plaintext) và không có dòng log nào in token.
5. **Port bận:** chạy một server khác chiếm port 3456 rồi bật API →
   Settings hiện lỗi rõ ràng ("port … is already in use"), app không crash.
6. **Tắt API** trong Settings → `curl /v1/health` không kết nối được nữa;
   bật lại → chạy lại bình thường. Tắt app → server dừng (không còn
   process nghe port).
7. **i18n:** `node --test tests/i18n.test.mjs` xanh (vi/en đủ key).

## 8. Giới hạn còn tồn đọng (worker 2 đã biết, chưa xử lý)

- **Token so sánh bằng `===`, không timing-safe:** chấp nhận được ở
  v0.5 vì server chỉ bind loopback cho chủ máy; trước khi mở API ra
  ngoài loopback phải đổi sang `crypto.timingSafeEqual` + rate limit.
- **Webhook không ký signature:** receiver chưa xác thực được nguồn
  POST (xem §1.2). Làm ở mốc sau: HMAC-SHA256 trên raw body, secret =
  API token, header `X-Open-Bot-Signature`.
- **Runs chỉ lưu in-memory:** restart app là mất lịch sử run
  (`GET /v1/runs/:id` trả 404 cho run cũ). Muốn bền thì lưu run vào
  SQLite/BotMemory ở mốc sau.
- **Chưa có WebSocket / streaming:** API hiện chỉ có polling
  (`GET /v1/runs/:id`); ROADMAP nhắc HTTP/WebSocket — stream delta
  theo thời gian thực là việc của mốc sau.
- **Chưa có phân quyền theo token:** một token duy nhất dùng được mọi
  bot và mọi route (kể cả đọc history). Service account / scope
  (`run` vs `admin`) là việc của worker team v0.5 — khi có thì API
  nên chấp nhận cả token service account.
- **Chưa có test e2e Electron:** test hiện tại chỉ ở tầng core
  (node:test + mock handler). Luồng IPC + Settings UI + webhook thật
  cần kiểm thử tay theo §7.
- **Token regenerate khi server đang chạy:** đã xử lý bằng restart
  server trong handler (§3.4); nếu restart lỗi (port bị chiếm trong
  lúc đó) thì API tắt cho tới khi người dùng bật lại — chấp nhận được
  ở v0.5, mốc sau có thể giữ server cũ chạy tới khi start mới thành công.
