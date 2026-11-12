# v0.4 worker 2 — Đặc tả tích hợp (Skills + Automations/Dream)

> Tài liệu này dành cho **điều phối viên v0.4** áp dụng phần core do worker 2
> (skills + automations/dream) bàn giao. Core đã xong, đã test; phần dưới đây
> là **toàn bộ code cần thêm/sửa ở main process, preload và renderer** —
> worker 2 bị cấm chạm các file đó nên chưa viết. Copy code mẫu vào đúng vị
> trí được chỉ, rồi chạy `npm run build` toàn repo + test lại.
>
> Quy ước: mọi chuỗi hiển thị qua i18n (`t('...')`), không hard-code tiếng
> Việt/Anh trong component. API key không bao giờ rời main process (giữ
> nguyên quy tắc của `settingsForRenderer()`).

## 0. Core đã bàn giao — dùng như thế nào

### 0.1. Import

```ts
// packages/core/src/skills/index.ts và packages/core/src/automations/index.ts
// đã export sẵn. Điều phối viên thêm 2 dòng này vào packages/core/src/index.ts
// (worker 2 không được sửa file đó):
export * from './skills/index';
export * from './automations/index';
```

> Lưu ý: `export *` sẽ va chạm tên nếu worker khác (vault/voice/perf) export
> cùng tên — kiểm tra `npx tsc --noEmit -p packages/core/tsconfig.json` sau
> khi gộp; nếu va chạm, đổi sang export có chọn lọc từng tên.

### 0.2. API core (đã có, đã test)

**Skills** — `SkillRegistry`, `applySkills(systemPrompt, skills)`:

```ts
import { SkillRegistry } from '@open-bot/core';

const skills = new SkillRegistry({
  userSkillsDir: path.join(app.getPath('userData'), 'skills'),   // <userData>/skills/*.md
  pluginsDir: path.join(app.getPath('userData'), 'plugins'),     // <plugin>/skills/*.md
  stateDir: app.getPath('userData'),                             // skills-enabled.json
});
skills.load();                       // đọc lại toàn bộ skill
skills.list();                       // tất cả skill (kèm enabled)
skills.matchSkills(userText, 3);     // [{ skill, score }] — chỉ skill đang bật, score > 0
skills.enable('code-review');        // disable('...') — lưu bền vào skills-enabled.json
skills.applySkillsForTask(bot.systemPrompt, userText, 3); // system prompt đã chèn skill
```

- Skill = file Markdown có YAML frontmatter (`name`, `description`,
  `version`, `when-to-use`, `tools`) + body hướng dẫn. Loader từ chối file
  chứa nội dung giống secret (API key/token/password) và file lỗi không
  chặn các file khác (`registry.errors()` liệt kê file lỗi).
- 3 skill built-in: `code-review`, `research-brief`, `writing-vi`.
- Plugin expose skill **chỉ bằng quy ước thư mục** `<plugin-dir>/skills/*.md`
  — `packages/tools/src/plugins/loader.ts` (v0.3) không biết về skill,
  manifest không có trường `skills`, loader skill đọc thẳng từ đĩa và
  không `require()` code plugin nên skill không bao giờ thực thi được.

**Automations** — `AutomationScheduler`, `JsonFileAutomationStore`,
`Automation` / `AutomationHandlers`:

```ts
import { AutomationScheduler, JsonFileAutomationStore } from '@open-bot/core';

const scheduler = new AutomationScheduler(
  new JsonFileAutomationStore(path.join(app.getPath('userData'), '.open-bot')),
  handlers,                       // xem §1.3 — bắt buộc phải nối đủ 4 hàm
  { tickMs: 60_000, isChatActive: () => activeChatRuns.size > 0 },
);
scheduler.start();                 // tick mỗi 60s; stop() khi app thoát
scheduler.create({ botId, name, trigger, action, enabled }); // trigger: interval | cron | event | manual
scheduler.list(); scheduler.get(id); scheduler.update(a); scheduler.remove(id);
scheduler.setEnabled(id, false);
await scheduler.runNow(id);        // chạy ngay, bất kể lịch
await scheduler.tick();            // 1 lượt quét (dùng cho test/kích hoạt tay)
await scheduler.notifyEvent({ kind: 'agent-done', botId, text, at: new Date().toISOString() });
scheduler.listRuns(automationId);  // lịch sử chạy (tối đa 50 bản ghi)
```

- Trigger lịch: `{ kind: 'interval', minutes: N }` hoặc
  `{ kind: 'cron', expression: '0 9 * * 1-5' }` (cron tối giản 5 trường,
  tự viết parser, không dependency mới; hỗ trợ `*`, `*/n`, `a-b`, `a,b`).
- Trigger sự kiện: `{ kind: 'event', event: 'agent-done' | 'file-changed',
  pathPattern?: 'notes/*.md' }` + `condition: { textContains?, pathPattern? }`.
- Action: `{ kind: 'run-agent', botId, prompt }`,
  `{ kind: 'run-tool', tool, args? }`, `{ kind: 'create-task', botId, title }`,
  `{ kind: 'notify', message }`.
- **Chính sách chạy lỡ (đã cài trong scheduler, không được đổi lặng lẽ):**
  chạy lỡ quá grace window thì ghi run `status: 'skipped'` (lý do trong
  `output`) và lên lịch lại từ **hiện tại**, không chạy bù hàng loạt.
  Grace: interval = `max(2 × interval, 5 phút)`; cron = 60 phút.
  App tắt 1 tuần rồi mở lại cũng không nổ 1 tuần chạy dồn.
- File bền vững: `<userData>/.open-bot/automations.json` (ghi qua file tạm
  + rename; file hỏng được giữ lại thành `automations.json.corrupt` và load
  thành rỗng thay vì crash).
- Event trigger có cooldown mặc định 60s/automation (tránh spam khi nhiều
  file đổi cùng lúc) và không bao giờ chạy 2 lần song song.

**Dream** — `DreamEngine`, `buildDreamPrompt`:

```ts
import { DreamEngine } from '@open-bot/core';

const dream = new DreamEngine({
  config: { enabled: true, idleMinutes: 15, cheapestModel: cheapestModelForDream() },
  handlers,                       // chung handlers với scheduler
  isChatActive: () => activeChatRuns.size > 0,
  memory,                         // BotMemory — tuỳ chọn, để lưu last-activity bền
});
dream.noteActivity(botId);         // gọi mỗi khi user gửi chat / agent chạy xong
await dream.checkAndRun(botId, (id, limit) => memory.getHistory(id, limit));
// -> { ran: false, reason: 'disabled' | 'chat-active' | 'not-idle' | 'already-running' }
// -> { ran: true, summary, taskId? } — kết quả lưu thành task + notify, KHÔNG chèn vào chat
```

- Dream **không bao giờ ngắt chat đang chạy**: `checkAndRun()` trả về
  `chat-active` khi `isChatActive()` đúng; host phải gọi `noteActivity()`
  ở `chat:send` để đồng hồ rảnh chạy lại.
- Dream chạy bằng model rẻ nhất đã cấu hình (`cheapestModel`, xem §1.4).
  Sau 1 lượt dream, đồng hồ rảnh reset (lượt sau chờ đủ idle window).

**Routines cũ** — `packages/core/src/agent/routines.ts` đã mở rộng, API cũ
giữ nguyên (test cũ phải pass). Thêm:

```ts
import { routineToAutomation, routinesToAutomations, deleteRoutine } from '@open-bot/core';
// routineToAutomation(routine): Automation — interval trigger + run-agent action, giữ nguyên id
// routinesToAutomations(memory, botId): Automation[] — đổi toàn bộ routine của 1 bot
// deleteRoutine(memory, botId, routineId): boolean — xoá routine sau khi đã migrate xong
```

## 1. Main process — `apps/desktop/src/main/main.ts`

### 1.1. Vị trí đặt code mới

Thêm import ở đầu file (cùng nhóm import `@open-bot/core` hiện có):

```ts
import {
  AutomationScheduler,
  DreamEngine,
  JsonFileAutomationStore,
  SkillRegistry,
  type Automation,
  type AutomationEvent,
  type AutomationHandlers,
  type DreamConfig,
} from '@open-bot/core';
```

Khai báo module-level, ngay dưới `let coordinator: CoordinatorClient | null = null;`
(khu vực runtime, sau hàm `getCoordinator()` cũng được — miễn là trước
`registerIpc()` vì IPC handler dùng chúng):

```ts
// --- v0.4: skills + automations + dream (worker 2: core đã xong, main nối dây) ---
let skillRegistry: SkillRegistry | null = null;
let automationScheduler: AutomationScheduler | null = null;
let dreamEngine: DreamEngine | null = null;
/** Bot đang có chat chạy (chat:send) hoặc automation/dream đang chạy agent. */
const activeChatRuns = new Set<string>();
/** Dream config lưu trong settings.json (xem §1.4). */
let dreamConfig: DreamConfig = { enabled: false, idleMinutes: 15 };

function getSkillRegistry(): SkillRegistry {
  if (!skillRegistry) {
    skillRegistry = new SkillRegistry({
      userSkillsDir: path.join(app.getPath('userData'), 'skills'),
      pluginsDir: path.join(app.getPath('userData'), 'plugins'),
      stateDir: app.getPath('userData'),
    });
    skillRegistry.load();
  }
  return skillRegistry;
}
```

### 1.2. Khởi động scheduler + dream khi app mở

Trong `app.whenReady().then(...)` hiện có (cuối file, sau `registerIpc();`
và trước `createWindow();` — scheduler cần `settings` đã load để biết
`cheapestModel`, nên đặt sau `settings = loadSettings();`):

```ts
void app.whenReady().then(() => {
  settings = loadSettings();
  ensureDefaultBot();
  dreamConfig = loadDreamConfig();           // §1.4 — đọc từ settings.json
  initAutomations();                         // §1.3 — tạo scheduler + dream, start()
  initFileWatcher();                         // §1.5 — fs.watch workspace từng bot
  registerIpc();
  createWindow();
  // ...
});
```

Trong `app.on('before-quit', ...)` hiện có, thêm trước `coordinator.dispose()`:

```ts
app.on('before-quit', () => {
  saveSettings();
  automationScheduler?.stop();              // dừng timer tick
  if (coordinator) {
    void coordinator.dispose().catch(() => undefined);
  }
});
```

### 1.3. Handlers nối scheduler/dream vào AgentRunner + ToolRegistry + BotMemory

**Đây là phần nối quan trọng nhất.** Scheduler/dream không tự chạy agent
hay tool — chúng gọi 4 hàm host cung cấp. Viết đúng 1 lần như sau, đặt
ngay sau `getOrCreateRuntime()`:

```ts
/** Model rẻ nhất đã cấu hình — dream/automation dùng model này thay vì model mặc định. */
function cheapestModelForDream(): string | undefined {
  // Ưu tiên Ollama local (miễn phí, chạy trên máy); nếu chưa cấu hình thì
  // dùng defaultModel của provider xai; cuối cùng là model của bot đầu tiên.
  const ollama = settings.providers['ollama'];
  if (ollama?.defaultModel?.trim()) return ollama.defaultModel.trim();
  const xai = settings.providers['xai'];
  if (xai?.defaultModel?.trim()) return xai.defaultModel.trim();
  return settings.bots[0]?.model || undefined;
}

function buildAutomationHandlers(): AutomationHandlers {
  return {
    // Chạy 1 lượt agent qua coordinator (nơi AgentRunner sống). Đánh dấu
    // active để scheduler/dream không chạy chồng lên nhau, và để dream
    // không chen vào giữa lượt automation đang chạy.
    runAgent: async (botId, prompt, opts) => {
      const bot = settings.bots.find((b) => b.id === botId) ?? settings.bots[0];
      if (!bot) throw new Error('Không có bot nào để chạy automation.');
      activeChatRuns.add(bot.id);
      try {
        // LƯU Ý CHO ĐIỀU PHỐI VIÊN: coordinator hiện tại chưa có chế độ "silent".
        // Lượt chạy nền (automation/dream) KHÔNG được đẩy event delta/toolcall
        // về chat UI. Cần coordinator hỗ trợ run(botId, text, { silent: true })
        // để routeCoordinatorEvent bỏ qua event khi silent (xem §4, mục mở).
        // Tạm thời: truyền prompt kèm model rẻ nhất qua modelOverride nếu
        // coordinator hỗ trợ; nếu chưa, dùng model của bot.
        const result = await getCoordinator().run(bot.id, prompt);
        return result.text ?? '';
      } finally {
        activeChatRuns.delete(bot.id);
      }
    },
    // Chạy 1 tool qua coordinator. Cần coordinator expose 1 RPC runTool
    // (xem §4, mục mở) — nếu chưa có, tạm thời throw Error rõ ràng để
    // automation run-tool ghi run status 'error' thay vì crash scheduler.
    runTool: async (name, args) => {
      if (typeof (getCoordinator() as unknown as { runTool?: unknown }).runTool !== 'function') {
        throw new Error(`Tool "${name}" chưa chạy được từ automation: coordinator chưa expose runTool.`);
      }
      const out = await (
        getCoordinator() as unknown as { runTool: (n: string, a: Record<string, unknown>) => Promise<string> }
      ).runTool(name, args);
      return out;
    },
    // Tạo task: đi qua coordinator.listTasks/createTask RPC nếu có; nếu
    // chưa có RPC tạo task, dùng BotMemory ở main là SAI (BotMemory sống
    // trong coordinator — main KHÔNG BAO GIỜ mở memory.db trực tiếp, xem
    // comment ở interface BotRuntime). Tạm thời: ghi task vào runtime.tasks
    // dự phòng + trả về id tự sinh, và ghi chú trong run output.
    createTask: async (botId, title) => {
      const coordinator = getCoordinator() as unknown as {
        createTask?: (botId: string, title: string) => Promise<{ id: string }>;
      };
      if (typeof coordinator.createTask === 'function') {
        const created = await coordinator.createTask(botId, title);
        return created.id;
      }
      const id = randomUUID();
      const runtime = runtimes.get(botId);
      runtime?.tasks.push({ id, botId, title, status: 'pending' } as TaskItem);
      return id;
    },
    notify: (message) => {
      // Gửi về renderer để hiện banner/thông báo, không chèn vào chat.
      sendToRenderer('automation:notify', { message, at: Date.now() });
    },
    cheapestModel: cheapestModelForDream(),
  };
}

function initAutomations(): void {
  const handlers = buildAutomationHandlers();
  automationScheduler = new AutomationScheduler(
    new JsonFileAutomationStore(path.join(app.getPath('userData'), '.open-bot')),
    handlers,
    { tickMs: 60_000, isChatActive: () => activeChatRuns.size > 0 },
  );
  dreamEngine = new DreamEngine({
    config: { ...dreamConfig, cheapestModel: cheapestModelForDream() },
    handlers,
    isChatActive: () => activeChatRuns.size > 0,
    // memory: KHÔNG truyền BotMemory của main — BotMemory sống trong
    // coordinator. Dream lưu last-activity in-memory; khi app khởi động
    // lại, đồng hồ rảnh bắt đầu lại từ lúc mở app (chấp nhận được, ghi rõ
    // trong UI: "dream chỉ tính thời gian rảnh trong phiên này").
  });
  automationScheduler.start();
  // Dream không có timer riêng: scheduler tick mỗi 60s gọi dream cho từng
  // bot (xem tickDreamBelow). Đặt hook ngay sau scheduler.start():
  const tick = automationScheduler.tick.bind(automationScheduler);
  automationScheduler.tick = async () => {
    const runs = await tick();
    await runDreamForIdleBots();
    return runs;
  };
}

/** Mỗi tick: thử dream cho từng bot (dream tự kiểm tra idle/chat-active). */
async function runDreamForIdleBots(): Promise<void> {
  if (!dreamEngine) return;
  for (const bot of settings.bots) {
    try {
      const result = await dreamEngine.checkAndRun(bot.id, (id, limit) =>
        // getHistory trả về { role, content } — đúng kiểu buildDreamPrompt cần.
        // Dùng coordinator.getHistory (async) nên phải bọc: checkAndRun nhận
        // hàm sync, vì vậy đọc history TRƯỚC rồi truyền closure đã có dữ liệu:
        [],
      );
      void result;
    } catch {
      // Dream lỗi không được làm chết tick scheduler.
    }
  }
}
```

> **Sửa lại `runDreamForIdleBots` cho đúng async (code trên là khung — bản
> chạy thật phải đọc history trước):**

```ts
async function runDreamForIdleBots(): Promise<void> {
  if (!dreamEngine) return;
  for (const bot of settings.bots) {
    try {
      // Đọc history trước (async), rồi đưa vào checkAndRun dạng sync.
      let history: Array<{ role: string; content: string }> = [];
      try {
        const { messages } = await getCoordinator().getHistory(bot.id, 20);
        history = messages.map((m) => ({ role: m.role, content: m.content }));
      } catch {
        history = [];
      }
      const snapshot = history;
      await dreamEngine.checkAndRun(bot.id, () => snapshot);
    } catch {
      // Dream lỗi không được làm chết tick scheduler.
    }
  }
}
```

### 1.4. Dream config trong settings.json

`AppSettings` hiện có `{ providers, bots, locale }`. Thêm trường tuỳ chọn
(không phá settings cũ — file cũ thiếu trường thì dùng mặc định):

```ts
// Trong interface AppSettings (đầu main.ts), thêm:
interface AppSettings {
  providers: Record<string, ProviderSettings>;
  bots: BotConfig[];
  locale: AppLocale;
  /** v0.4: cấu hình dream (mặc định tắt). */
  dream?: DreamConfig;
}
```

Hàm load/save (đặt cạnh `loadSettings()` / `saveSettings()`):

```ts
function loadDreamConfig(): DreamConfig {
  const raw = (settings as AppSettings).dream;
  return {
    enabled: raw?.enabled === true,
    idleMinutes:
      typeof raw?.idleMinutes === 'number' && raw.idleMinutes >= 5 && raw.idleMinutes <= 240
        ? raw.idleMinutes
        : 15,
    cheapestModel: raw?.cheapestModel,
  };
}

function saveDreamConfig(next: DreamConfig): DreamConfig {
  dreamConfig = {
    enabled: next.enabled === true,
    idleMinutes:
      typeof next.idleMinutes === 'number' && next.idleMinutes >= 5 && next.idleMinutes <= 240
        ? next.idleMinutes
        : 15,
    cheapestModel: next.cheapestModel,
  };
  settings.dream = dreamConfig;
  saveSettings();
  // Áp dụng ngay cho engine đang chạy (không cần restart app).
  if (dreamEngine) {
    dreamEngine = new DreamEngine({
      config: { ...dreamConfig, cheapestModel: cheapestModelForDream() },
      handlers: buildAutomationHandlers(),
      isChatActive: () => activeChatRuns.size > 0,
    });
  }
  return dreamConfig;
}
```

### 1.5. File watcher — trigger `file-changed`

Đặt sau `initAutomations()`. `fs.watch` chỉ là best-effort (Linux không
đệ quy — chỉ theo dõi thư mục gốc của workspace; macOS/Windows đệ quy
được). Debounce 2s để 1 lần lưu file không nổ nhiều event:

```ts
import * as fs from 'node:fs'; // đã có sẵn ở đầu main.ts

const fileWatchers = new Map<string, fs.FSWatcher>();
const fileChangeTimers = new Map<string, ReturnType<typeof setTimeout>>();

function initFileWatcher(): void {
  for (const bot of settings.bots) {
    watchWorkspaceFor(bot);
  }
}

function watchWorkspaceFor(bot: BotConfig): void {
  const dir = workspaceDirFor(bot);
  if (fileWatchers.has(bot.id)) return;
  try {
    const watcher = fs.watch(dir, { recursive: true }, (_eventType, filename) => {
      if (!filename || typeof filename !== 'string') return;
      const key = `${bot.id}:${filename}`;
      clearTimeout(fileChangeTimers.get(key));
      fileChangeTimers.set(
        key,
        setTimeout(() => {
          void automationScheduler
            ?.notifyEvent({ kind: 'file-changed', botId: bot.id, path: filename, at: new Date().toISOString() })
            .catch(() => undefined);
        }, 2000),
      );
    });
    watcher.on('error', () => undefined);
    fileWatchers.set(bot.id, watcher);
  } catch {
    // Workspace chưa tồn tại / không watch được: automation file-changed
    // của bot này chỉ không chạy, app vẫn chạy bình thường.
  }
}
```

Gọi `watchWorkspaceFor(bot)` thêm trong handler `bots:create` sau khi
`settings.bots.push(bot)`, và đóng watcher trong `bots:delete`:

```ts
// bots:delete — thêm trước `saveSettings(); return true;`:
fileWatchers.get(botId)?.close();
fileWatchers.delete(botId);
```

### 1.6. Móc skill vào agent loop + móc activity vào chat

**Skill injection (khuyến nghị: làm ở coordinator, không phải main).**
AgentRunner sống trong tiến trình coordinator con; `loop.ts` dựng system
prompt từ `bot.systemPrompt` ở đầu `run()`. Cách nối sạch nhất, không sửa
`loop.ts`:

- Coordinator khi nhận `run(botId, text)`: trước khi tạo `AgentRunner`,
  gọi `skills.applySkillsForTask(bot.systemPrompt, text, 3)` (registry
  load 1 lần khi coordinator khởi động, reload khi main báo skill đổi —
  xem IPC `skills:reload` ở §2) rồi truyền bot config với systemPrompt đã
  chèn skill vào runner cho lượt chạy đó. System prompt gốc trong
  settings KHÔNG đổi (chỉ chèn theo lượt).
- Phương án dự phòng (nếu coordinator chưa sửa được): main làm ở
  `chat:send` — nhưng main không sở hữu runner nên không chèn được; vì
  vậy phương án này cần coordinator hỗ trợ `run(botId, text, { systemPromptOverride })`.
  Điều phối viên chọn 1 trong 2, ghi rõ vào commit message.

**Activity tracking (main, trong `chat:send` hiện có):**

```ts
// Trong ipcMain.handle('chat:send', ...) — ngay sau khi kiểm tra text rỗng:
activeChatRuns.add(bot.id);
dreamEngine?.noteActivity(bot.id);
// ... phần try/catch hiện có giữ nguyên ...
// Trong khối finally của try/catch đó (thêm finally nếu chưa có):
//   activeChatRuns.delete(bot.id);
//   dreamEngine?.noteActivity(bot.id); // lượt chat vừa xong cũng là activity
//   void automationScheduler?.notifyEvent({
//     kind: 'agent-done', botId: bot.id, text: replyText,
//     at: new Date().toISOString(),
//   }).catch(() => undefined);
```

Lưu ý: `chat:send` hiện trả `{ ok, text }` trong try và `{ ok:false }`
trong catch — bọc phần gọi `getCoordinator().run(...)` bằng
try/finally để `activeChatRuns.delete` luôn chạy kể cả khi lỗi.

### 1.7. IPC handlers — thêm vào cuối `registerIpc()` (trước `ipcMain.on('chat:approval-response', ...)`)

```ts
// --- v0.4: skills ---
ipcMain.handle('skills:list', () => {
  const registry = getSkillRegistry();
  return registry.list().map((s) => ({
    name: s.name, description: s.description, version: s.version,
    whenToUse: s.whenToUse, tools: s.tools, source: s.source,
    pluginId: s.pluginId ?? null, enabled: s.enabled,
  }));
});

ipcMain.handle('skills:toggle', (_event: unknown, payload: { name: string; enabled: boolean }) => {
  const registry = getSkillRegistry();
  const ok = payload.enabled ? registry.enable(payload.name) : registry.disable(payload.name);
  if (!ok) throw new Error(`Không tìm thấy skill "${payload.name}".`);
  return registry.get(payload.name)?.enabled ?? false;
});

ipcMain.handle('skills:reload', () => {
  const registry = getSkillRegistry();
  const skills = registry.load();
  // TODO(coordinator): báo cho coordinator reload registry của nó (xem §4).
  return { skills: skills.map((s) => s.name), errors: registry.errors() };
});

// --- v0.4: automations ---
ipcMain.handle('automations:list', () => automationScheduler?.list() ?? []);

ipcMain.handle('automations:get', (_event: unknown, payload: { id: string }) => {
  const found = automationScheduler?.get(payload.id);
  if (!found) throw new Error('Không tìm thấy automation.');
  return found;
});

ipcMain.handle('automations:create', (_event: unknown, payload: Omit<Automation, 'id' | 'createdAt' | 'updatedAt'>) => {
  if (!automationScheduler) throw new Error('Scheduler chưa khởi động.');
  const bot = settings.bots.find((b) => b.id === payload.botId);
  if (payload.botId && !bot) throw new Error('Không tìm thấy bot.');
  return automationScheduler.create(payload);
});

ipcMain.handle('automations:update', (_event: unknown, payload: Automation) => {
  if (!automationScheduler) throw new Error('Scheduler chưa khởi động.');
  return automationScheduler.update(payload);
});

ipcMain.handle('automations:delete', (_event: unknown, payload: { id: string }) => {
  if (!automationScheduler) throw new Error('Scheduler chưa khởi động.');
  return automationScheduler.remove(payload.id);
});

ipcMain.handle('automations:set-enabled', (_event: unknown, payload: { id: string; enabled: boolean }) => {
  if (!automationScheduler) throw new Error('Scheduler chưa khởi động.');
  return automationScheduler.setEnabled(payload.id, payload.enabled);
});

ipcMain.handle('automations:run-now', async (_event: unknown, payload: { id: string }) => {
  if (!automationScheduler) throw new Error('Scheduler chưa khởi động.');
  return automationScheduler.runNow(payload.id);
});

ipcMain.handle('automations:runs', (_event: unknown, payload: { automationId?: string }) => {
  return automationScheduler?.listRuns(payload.automationId) ?? [];
});

// --- v0.4: dream ---
ipcMain.handle('dream:get', () => ({ ...dreamConfig }));

ipcMain.handle('dream:set', (_event: unknown, payload: DreamConfig) => {
  return saveDreamConfig(payload); // §1.4 — lưu settings.json + áp dụng ngay
});
```

**Validate payload ở main (không tin renderer):** `automations:create/update`
đã được `scheduler.create/update` validate bằng `validateAutomation()` và
throw `Error('Invalid automation: ...')` khi sai — IPC chỉ việc để lỗi
nổi lên (renderer hiện lỗi đó). Không cần validate thêm, nhưng **không**
được `catch` rồi trả `{ ok: true }` giả.

## 2. Preload — `apps/desktop/src/main/preload.ts`

Thêm vào `OpenBotApi` (sau khối team, trước dấu `}` đóng interface) và vào
object `openBot` (cùng thứ tự):

```ts
export interface OpenBotApi {
  // ... các hàm hiện có ...
  // v0.4: skills.
  listSkills: () => Promise<Array<{
    name: string; description: string; version: string; whenToUse: string;
    tools: string[]; source: string; pluginId: string | null; enabled: boolean;
  }>>;
  toggleSkill: (name: string, enabled: boolean) => Promise<boolean>;
  reloadSkills: () => Promise<{ skills: string[]; errors: Array<{ file: string; error: string }> }>;
  // v0.4: automations.
  listAutomations: () => Promise<unknown[]>;
  getAutomation: (id: string) => Promise<unknown>;
  createAutomation: (automation: unknown) => Promise<unknown>;
  updateAutomation: (automation: unknown) => Promise<unknown>;
  deleteAutomation: (id: string) => Promise<boolean>;
  setAutomationEnabled: (id: string, enabled: boolean) => Promise<unknown>;
  runAutomationNow: (id: string) => Promise<unknown>;
  listAutomationRuns: (automationId?: string) => Promise<unknown[]>;
  // v0.4: dream.
  getDream: () => Promise<{ enabled: boolean; idleMinutes?: number; cheapestModel?: string }>;
  setDream: (config: { enabled: boolean; idleMinutes?: number }) => Promise<unknown>;
  // v0.4: notification từ automation/dream (main -> renderer, 1 chiều).
  onAutomationNotify: (cb: (payload: { message: string; at: number }) => void) => () => void;
}
```

```ts
const openBot: OpenBotApi = {
  // ... các hàm hiện có ...
  listSkills: () => ipcRenderer.invoke('skills:list'),
  toggleSkill: (name, enabled) => ipcRenderer.invoke('skills:toggle', { name, enabled }),
  reloadSkills: () => ipcRenderer.invoke('skills:reload'),
  listAutomations: () => ipcRenderer.invoke('automations:list'),
  getAutomation: (id) => ipcRenderer.invoke('automations:get', { id }),
  createAutomation: (automation) => ipcRenderer.invoke('automations:create', automation),
  updateAutomation: (automation) => ipcRenderer.invoke('automations:update', automation),
  deleteAutomation: (id) => ipcRenderer.invoke('automations:delete', { id }),
  setAutomationEnabled: (id, enabled) => ipcRenderer.invoke('automations:set-enabled', { id, enabled }),
  runAutomationNow: (id) => ipcRenderer.invoke('automations:run-now', { id }),
  listAutomationRuns: (automationId) => ipcRenderer.invoke('automations:runs', { automationId }),
  getDream: () => ipcRenderer.invoke('dream:get'),
  setDream: (config) => ipcRenderer.invoke('dream:set', config),
  onAutomationNotify: (cb) => subscribe('automation:notify', cb),
};
```

Không expose thêm gì khác. Đặc biệt: **không** expose `automationScheduler`,
`dreamEngine`, `SkillRegistry`, đường dẫn file, hay API key.

## 3. Renderer

### 3.1. `App.tsx` — thêm 2 view vào state `view`

Hiện có:

```tsx
const [view, setView] = useState<'chat' | 'settings' | 'marketplace' | 'mcp' | 'team'>('chat');
```

Đổi thành:

```tsx
const [view, setView] = useState<'chat' | 'settings' | 'marketplace' | 'mcp' | 'team' | 'skills' | 'automations'>('chat');
```

Thêm vào JSX (cùng mẫu với `marketplace`/`mcp`/`team`, đặt sau khối `team`):

```tsx
) : view === 'skills' ? (
  <SkillsView onBack={() => setView('chat')} />
) : view === 'automations' ? (
  <AutomationsView botId={selectedBotId} onBack={() => setView('chat')} />
) : (
  <ChatView /* ...props hiện có... */ />
)}
```

Và truyền thêm 2 callback vào `<Sidebar ... />`:

```tsx
onOpenSkills={() => setView('skills')}
onOpenAutomations={() => setView('automations')}
```

### 3.2. `Sidebar.tsx` — thêm 2 nút + 2 prop

```tsx
interface Props {
  // ... props hiện có ...
  onOpenSkills: () => void;
  onOpenAutomations: () => void;
}

// Trong phần nút cuối sidebar (cạnh nút Marketplace/MCP/Team/Settings):
<button className="btn secondary" onClick={onOpenSkills}>🧠 {t('sidebar.skills')}</button>
<button className="btn secondary" onClick={onOpenAutomations}>⏰ {t('sidebar.automations')}</button>
```

### 3.3. Mới: `components/SkillsView.tsx`

```tsx
import { useEffect, useState } from 'react';
import { useT } from '../i18n/useT';

interface SkillRow {
  name: string; description: string; version: string; whenToUse: string;
  tools: string[]; source: string; pluginId: string | null; enabled: boolean;
}

export default function SkillsView({ onBack }: { onBack: () => void }) {
  const t = useT();
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      setSkills(await window.openBot.listSkills());
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('skills.loadError'));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const toggle = async (name: string, enabled: boolean) => {
    try {
      await window.openBot.toggleSkill(name, enabled);
      setSkills((prev) => prev.map((s) => (s.name === name ? { ...s, enabled } : s)));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('skills.toggleError'));
    }
  };

  return (
    <div className="view">
      <button className="btn secondary" onClick={onBack}>{t('skills.back')}</button>
      <h2>{t('skills.title')}</h2>
      <p>{t('skills.intro')}</p>
      {loading && <p>{t('skills.loading')}</p>}
      {error && <p className="error">{error}</p>}
      {skills.map((s) => (
        <section key={s.name} className="card">
          <h3>{s.name} <span className="badge">v{s.version}</span> {s.source === 'builtin' && <span>{t('skills.builtin')}</span>}</h3>
          <p>{s.description}</p>
          {s.whenToUse && <p><em>{t('skills.whenToUse')}: {s.whenToUse}</em></p>}
          {s.tools.length > 0 && <p>{t('skills.tools')}: {s.tools.join(', ')}</p>}
          {s.pluginId && <p>{t('skills.fromPlugin')}: {s.pluginId}</p>}
          <label>
            <input type="checkbox" checked={s.enabled} onChange={(e) => void toggle(s.name, e.target.checked)} />
            {t('skills.enabled')}
          </label>
        </section>
      ))}
      {skills.length === 0 && !loading && <p>{t('skills.empty')}</p>}
      <button className="btn secondary" onClick={() => void load()}>{t('skills.reload')}</button>
    </div>
  );
}
```

- Nút "Tải lại" gọi `window.openBot.reloadSkills()` rồi `load()` lại;
  nếu `errors` trả về non-empty thì hiện `t('skills.reloadErrors')`
  kèm số file lỗi (không hiện đường dẫn đầy đủ — đường dẫn máy local
  không cần lộ ra UI, log chi tiết ở main là đủ).
- Không có UI tạo/sửa skill trong v0.4: user thêm skill bằng cách thả
  file `.md` vào `<userData>/skills/` rồi bấm Tải lại. Ghi rõ trong
  `skills.intro` (xem §3.5).

### 3.4. Mới: `components/AutomationsView.tsx`

Form tạo automation (đủ dùng, không cần đẹp hơn TaskPanel):

- Chọn bot (dropdown từ `bots` prop — component nhận `bots: BotConfigLike[]`
  và `botId: string | null`; nếu chưa chọn bot thì hiện
  `t('automations.selectBotFirst')`).
- Tên (text input, bắt buộc).
- Trigger: select `interval | cron | event | manual`.
  - `interval`: number input `minutes` (min 1).
  - `cron`: text input `expression` (placeholder `0 9 * * 1-5`), kèm
    hint `t('automations.cronHint')` — sai định dạng thì main trả lỗi
    `Invalid automation: ...`, hiện nguyên lỗi đó.
  - `event`: select `agent-done | file-changed`; nếu `file-changed` thì
    thêm text input `pathPattern` (placeholder `notes/*.md`); thêm text
    input `textContains` (chỉ dùng cho `agent-done`, tuỳ chọn).
  - `manual`: không thêm field.
- Action: select `run-agent | run-tool | create-task | notify`.
  - `run-agent`: textarea `prompt` (bắt buộc).
  - `run-tool`: text input `tool` + textarea `args` (JSON, parse ở
    renderer; JSON sai thì báo `t('automations.badArgsJson')` trước khi
    gọi IPC).
  - `create-task`: text input `title`.
  - `notify`: text input `message`.
- Danh sách automation hiện có: tên, trigger tóm tắt (VD `Mỗi 30 phút`,
  `Cron 0 9 * * 1-5`, `Khi agent xong việc`, `Chạy tay`), action tóm tắt,
  `nextRunAt` (định dạng giờ địa phương; `manual`/`event` hiện `—`),
  checkbox bật/tắt (`setAutomationEnabled`), nút `Chạy ngay`
  (`runAutomationNow` — disabled khi automation đang tắt), nút Xoá
  (confirm `t('automations.deleteConfirm')`).
- Lịch sử chạy: dưới mỗi automation (hoặc 1 bảng chung cuối view) hiện
  10 run gần nhất từ `listAutomationRuns(id)`: thời gian, trạng thái
  (`ok` / `error` / `skipped` — dùng key `automations.runStatus.*`),
  `output`/`error` cắt ngắn 200 ký tự (full text xem bằng `title` attr).
  Run `skipped` hiện kèm lý do (chính sách chạy lỡ, xem §0.2).

Kiểu dữ liệu renderer (thêm vào `renderer/types.ts`, cạnh `TaskView`):

```ts
export interface AutomationLike {
  id: string;
  botId: string;
  name: string;
  trigger: { kind: string; minutes?: number; expression?: string; event?: string; pathPattern?: string };
  condition?: { textContains?: string; pathPattern?: string };
  action: { kind: string; botId?: string; prompt?: string; tool?: string; args?: Record<string, unknown>; title?: string; message?: string };
  enabled: boolean;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRunLike {
  id: string;
  automationId: string;
  startedAt: string;
  finishedAt?: string;
  status: 'ok' | 'error' | 'skipped';
  output?: string;
  error?: string;
}
```

### 3.5. Mục Dream trong `SettingsView.tsx`

Thêm 1 `<section className="card">` sau section Ngôn ngữ (trước section
provider), dùng đúng mẫu `changeLocale` hiện có:

```tsx
const [dream, setDream] = useState<{ enabled: boolean; idleMinutes: number }>({ enabled: false, idleMinutes: 15 });

// Trong load settings (cùng useEffect load getSettings): sau khi có settings,
// gọi thêm: const d = await window.openBot.getDream(); setDream({ enabled: d.enabled, idleMinutes: d.idleMinutes ?? 15 });

<section className="card">
  <h3>{t('settings.dreamTitle')}</h3>
  <p>{t('settings.dreamIntro')}</p>
  <label>
    <input
      type="checkbox"
      checked={dream.enabled}
      onChange={(e) => void changeDream({ ...dream, enabled: e.target.checked })}
    />
    {t('settings.dreamEnableLabel')}
  </label>
  <label htmlFor="dream-idle">{t('settings.dreamIdleLabel')}</label>
  <input
    id="dream-idle"
    type="number"
    min={5}
    max={240}
    step={5}
    value={dream.idleMinutes}
    disabled={!dream.enabled}
    onChange={(e) => void changeDream({ ...dream, idleMinutes: Number(e.target.value) || 15 })}
  />
  <p>{t('settings.dreamModelNote')}</p>
</section>

// Hàm changeDream (đặt cạnh changeLocale):
const changeDream = async (next: { enabled: boolean; idleMinutes: number }) => {
  setDream(next);
  try {
    await window.openBot.setDream(next);
  } catch (e) {
    setError(e instanceof Error ? e.message : t('settings.dreamSaveError'));
  }
};
```

`dreamModelNote` phải nói rõ model dùng cho dream là model rẻ nhất đã
cấu hình (Ollama local nếu có, xem §1.3) — không hứa tên model cụ thể.

### 3.6. Thông báo automation — `App.tsx`

Đăng ký 1 lần trong `useEffect` đã có (nơi đăng ký `onChatDelta`...):

```tsx
useEffect(() => {
  const off = window.openBot.onAutomationNotify((payload) => {
    setNotices((prev) => [...prev, { id: uid(), text: payload.message, kind: 'info' }]);
  });
  return off;
}, []);
```

Dùng đúng kiểu `Notice` hiện có trong `types.ts`; nếu `Notice` không có
`kind: 'info'`, dùng đúng shape hiện tại của App (xem `setNotices` đang
dùng ở ChatView).

### 3.7. Chuỗi i18n cần thêm — `locales/vi.json` + `locales/en.json`

Thêm đúng các key dưới đây vào **cả 2 file** (key giống nhau, giá trị
dịch tương ứng; file JSON phẳng, 1 dòng như hiện tại). Không key nào
được hard-code trong component.

**Tiếng Việt (`vi.json`):**

```json
"sidebar.skills":"Kỹ năng",
"sidebar.automations":"Tự động hoá",
"skills.title":"Kỹ năng (Skills)",
"skills.intro":"Kỹ năng là hướng dẫn theo từng lĩnh vực mà agent đọc thêm khi làm việc. Thêm skill bằng cách thả file .md vào thư mục skills trong thư mục dữ liệu của app rồi bấm Tải lại. Skill không bao giờ chứa mật khẩu hay API key.",
"skills.back":"← Quay lại chat",
"skills.loading":"Đang tải…",
"skills.loadError":"Không tải được danh sách kỹ năng.",
"skills.toggleError":"Không đổi được trạng thái kỹ năng.",
"skills.builtin":"có sẵn",
"skills.whenToUse":"Dùng khi",
"skills.tools":"Công cụ liên quan",
"skills.fromPlugin":"Từ plugin",
"skills.enabled":"Bật kỹ năng này",
"skills.empty":"Chưa có kỹ năng nào.",
"skills.reload":"Tải lại từ đĩa",
"skills.reloadErrors":"Có {count} file skill lỗi — xem log của app để biết chi tiết.",
"automations.title":"Tự động hoá",
"automations.back":"← Quay lại chat",
"automations.selectBotFirst":"Chọn một bot ở cột bên trái trước, rồi quay lại đây để tạo automation cho bot đó.",
"automations.nameLabel":"Tên automation",
"automations.namePlaceholder":"vd: Nhắc tôi mỗi sáng",
"automations.triggerLabel":"Chạy khi",
"automations.trigger.interval":"Theo khoảng thời gian",
"automations.trigger.cron":"Theo lịch (cron)",
"automations.trigger.event":"Khi có sự kiện",
"automations.trigger.manual":"Chỉ chạy tay",
"automations.minutesLabel":"Mỗi (phút)",
"automations.cronLabel":"Biểu thức cron",
"automations.cronHint":"5 trường: phút giờ ngày tháng thứ — vd: 0 9 * * 1-5 (9h sáng thứ 2–6).",
"automations.eventLabel":"Sự kiện",
"automations.event.agentDone":"Agent xong việc",
"automations.event.fileChanged":"File đổi trong workspace",
"automations.pathPatternLabel":"Mẫu đường dẫn (vd: notes/*.md)",
"automations.textContainsLabel":"Chỉ chạy khi kết quả chứa chữ",
"automations.actionLabel":"Làm gì",
"automations.action.runAgent":"Chạy agent với prompt cho trước",
"automations.action.runTool":"Chạy 1 công cụ",
"automations.action.createTask":"Tạo nhiệm vụ",
"automations.action.notify":"Gửi thông báo",
"automations.promptLabel":"Prompt cho agent",
"automations.toolLabel":"Tên công cụ",
"automations.argsLabel":"Tham số (JSON)",
"automations.badArgsJson":"Tham số phải là JSON hợp lệ, vd: {\"path\": \"notes/todo.md\"}.",
"automations.titleLabel":"Tiêu đề nhiệm vụ",
"automations.messageLabel":"Nội dung thông báo",
"automations.createButton":"Tạo automation",
"automations.createError":"Không tạo được automation.",
"automations.runNow":"Chạy ngay",
"automations.delete":"Xoá",
"automations.deleteConfirm":"Xoá automation “{name}”?",
"automations.enabled":"Bật",
"automations.nextRun":"Chạy tiếp",
"automations.runsTitle":"Lịch sử chạy gần đây",
"automations.runStatus.ok":"Xong",
"automations.runStatus.error":"Lỗi",
"automations.runStatus.skipped":"Bỏ qua (chạy lỡ)",
"automations.loadError":"Không tải được danh sách automation.",
"settings.dreamTitle":"Dream — tác vụ nền khi rảnh",
"settings.dreamIntro":"Khi bật, app sẽ tự rà soát hoạt động gần đây sau một khoảng thời gian bạn không chat, rồi chuẩn bị tóm tắt và bản nháp dưới dạng nhiệm vụ. Dream không bao giờ ngắt khi bạn đang chat.",
"settings.dreamEnableLabel":"Bật Dream",
"settings.dreamIdleLabel":"Chờ rảnh (phút)",
"settings.dreamModelNote":"Dream chạy bằng model rẻ nhất đã cấu hình (ưu tiên model local Ollama nếu có) để không tốn credit của model chính.",
"settings.dreamSaveError":"Không lưu được cài đặt Dream."
```

**Tiếng Anh (`en.json`)** — dịch tương ứng, cùng key:

```json
"sidebar.skills":"Skills",
"sidebar.automations":"Automations",
"skills.title":"Skills",
"skills.intro":"Skills are per-domain instructions the agent reads while working. Add one by dropping a .md file into the skills folder inside the app data directory, then press Reload. A skill must never contain a password or API key.",
"skills.back":"← Back to chat",
"skills.loading":"Loading…",
"skills.loadError":"Could not load the skill list.",
"skills.toggleError":"Could not change the skill state.",
"skills.builtin":"built-in",
"skills.whenToUse":"Use when",
"skills.tools":"Related tools",
"skills.fromPlugin":"From plugin",
"skills.enabled":"Enable this skill",
"skills.empty":"No skills yet.",
"skills.reload":"Reload from disk",
"skills.reloadErrors":"{count} skill files failed to load — see the app log for details.",
"automations.title":"Automations",
"automations.back":"← Back to chat",
"automations.selectBotFirst":"Pick a bot in the left column first, then come back here to create an automation for it.",
"automations.nameLabel":"Automation name",
"automations.namePlaceholder":"e.g. Remind me every morning",
"automations.triggerLabel":"Run when",
"automations.trigger.interval":"On an interval",
"automations.trigger.cron":"On a schedule (cron)",
"automations.trigger.event":"When an event happens",
"automations.trigger.manual":"Manual only",
"automations.minutesLabel":"Every (minutes)",
"automations.cronLabel":"Cron expression",
"automations.cronHint":"5 fields: minute hour day month weekday — e.g. 0 9 * * 1-5 (9am Mon–Fri).",
"automations.eventLabel":"Event",
"automations.event.agentDone":"Agent finished a job",
"automations.event.fileChanged":"File changed in the workspace",
"automations.pathPatternLabel":"Path pattern (e.g. notes/*.md)",
"automations.textContainsLabel":"Only run when the result contains",
"automations.actionLabel":"Do what",
"automations.action.runAgent":"Run the agent with a fixed prompt",
"automations.action.runTool":"Run one tool",
"automations.action.createTask":"Create a task",
"automations.action.notify":"Send a notification",
"automations.promptLabel":"Prompt for the agent",
"automations.toolLabel":"Tool name",
"automations.argsLabel":"Arguments (JSON)",
"automations.badArgsJson":"Arguments must be valid JSON, e.g. {\"path\": \"notes/todo.md\"}.",
"automations.titleLabel":"Task title",
"automations.messageLabel":"Notification text",
"automations.createButton":"Create automation",
"automations.createError":"Could not create the automation.",
"automations.runNow":"Run now",
"automations.delete":"Delete",
"automations.deleteConfirm":"Delete automation “{name}”?",
"automations.enabled":"Enabled",
"automations.nextRun":"Next run",
"automations.runsTitle":"Recent runs",
"automations.runStatus.ok":"Done",
"automations.runStatus.error":"Error",
"automations.runStatus.skipped":"Skipped (missed run)",
"automations.loadError":"Could not load the automation list.",
"settings.dreamTitle":"Dream — background work while idle",
"settings.dreamIntro":"When enabled, the app reviews recent activity after you have not chatted for a while, then prepares a summary and a draft as a task. Dream never interrupts you while you are chatting.",
"settings.dreamEnableLabel":"Enable Dream",
"settings.dreamIdleLabel":"Wait while idle (minutes)",
"settings.dreamModelNote":"Dream runs on the cheapest configured model (a local Ollama model first, when available) so it does not spend your main model's credit.",
"settings.dreamSaveError":"Could not save the Dream settings."
```

## 4. Mục mở / việc còn lại cho điều phối viên (không thuộc core v0.4)

1. **Coordinator `run` chế độ silent** — lượt chạy nền (automation
   `run-agent`, dream) hiện đi qua `getCoordinator().run()` và sẽ đẩy
   event về chat UI qua `routeCoordinatorEvent`. Cần thêm
   `run(botId, text, { silent?: boolean })` (client + server coordinator)
   để event bị chặn khi silent; kết quả nền chỉ đi qua notify/task.
   Nếu không làm mục này, automation/dream vẫn chạy đúng nhưng spam chat.
2. **Coordinator RPC `runTool` + `createTask`** — `buildAutomationHandlers`
   ở §1.3 đã viết sẵn code chờ 2 RPC này; nếu coordinator chưa expose,
   action `run-tool` trả run `error` rõ ràng (không crash), còn
   `create-task` rơi về task dự phòng trong `runtimes` (task đó không bền
   vững — chỉ là fallback, không phải thiết kế cuối).
3. **Coordinator reload skill registry** — khi renderer bấm Tải lại skill
   (`skills:reload`), registry của coordinator (nơi skill được chèn vào
   system prompt, §1.6) cũng phải load lại; main cần 1 cơ chế báo cho
   coordinator (RPC `reloadSkills` hoặc restart bot runtime).
4. **Migrate routines cũ** — khi scheduler đã chạy ổn: với mỗi bot, gọi
   `routinesToAutomations(memory, botId)` rồi `scheduler.create(...)`
   từng automation, sau đó `deleteRoutine(...)` để xoá routine gốc.
   Làm 1 lần, có log; không xoá routine trước khi automation đã lưu xong.
   (BotMemory sống trong coordinator — bước này phải chạy ở phía
   coordinator hoặc qua RPC, không mở `memory.db` từ main.)
5. **Test tay sau khi nối (bắt buộc trước khi coi v0.4 xong):**
   - Skills: bật/tắt `code-review`, chat "review code giúp tôi" → skill
     được chèn (kiểm tra bằng log/tạm thời hiện skill đã match ở UI debug);
     thả 1 file `.md` lỗi vào `<userData>/skills/` → Tải lại báo lỗi nhưng
     skill khác vẫn chạy.
   - Automations: tạo automation interval 1 phút `notify` → thấy thông
     báo sau ~1 phút; `run-now` chạy ngay; tắt app 10 phút rồi mở lại
     với automation interval 1 phút → run `skipped`, không nổ hàng loạt.
   - Dream: bật dream, idle 15 phút (hoặc chỉnh idle 5 phút để test),
     không chat → task "Dream: ..." xuất hiện; chat trong lúc dream sắp
     chạy → dream không chạy.

## 5. Checklist nghiệm thu cho điều phối viên

- [ ] `packages/core/src/index.ts` export skills + automations (xem §0.1).
- [ ] `npm run build --workspace=@open-bot/core` xanh; `node --test
      tests/skills.test.mjs tests/automations.test.mjs` xanh.
- [ ] App mở lên: scheduler start, không crash khi chưa có automation nào.
- [ ] IPC `skills:*`, `automations:*`, `dream:*` trả đúng; preload expose đủ.
- [ ] View Skills + view Automations mở được từ Sidebar; Dream trong Settings lưu được.
- [ ] Test tay §4 mục 5 đã làm, ghi kết quả vào commit message.
