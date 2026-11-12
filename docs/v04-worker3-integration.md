# Đặc tả tích hợp v0.4 — worker 3: Voice + Hiệu năng (queue/worker pool/cache)

> Tài liệu này để **điều phối viên** áp dụng vào `apps/desktop` và
> `packages/core/src/coordinator`. Mọi module lõi đã viết xong, build +
> test qua (xem §9); phần dưới đây là code mẫu đầy đủ để nối chúng vào
> app. **Không** sửa các file lõi của worker 3 khi nối — nếu code mẫu
> không khớp thực tế thì sửa code mẫu, báo lại worker 3.
>
> Quy ước: code TypeScript trong doc này là mẫu **đầy đủ, copy được**,
> chỉ còn chờ điền đúng vị trí trong file đích. Chuỗi UI nào cũng qua
> i18n (khóa ở §7), không hard-code tiếng Việt/Anh trong component.

## 0. Module đã có (worker 3 bàn giao)

| Module | Import path (xem lưu ý §8) | Dùng ở |
|---|---|---|
| `RealtimeClient`, `transcribeAudio` | `@open-bot/core/dist/voice/index` | main |
| `JobQueue`, `WorkerPool` | `@open-bot/core/dist/perf/index` | main |
| `ToolResultCache`, `SUGGESTED_CACHEABLE_TOOLS` | `@open-bot/core/dist/perf/index` | coordinator |
| `ToolRegistry` (+ `execute()`, `setCache()`, `cacheStats()`, `clearCache()`) | `@open-bot/tools` | coordinator |

Test: `tests/voice.test.mjs`, `tests/perf.test.mjs` — 23/23 pass.

## 1. Kiến trúc nối — đọc trước khi chạm code

Ba điểm quyết định vị trí đặt code:

1. **AgentRunner + ToolRegistry sống trong tiến trình coordinator con**
   (`packages/core/src/coordinator/coordinator.ts`, `defaultToolFactory`
   dòng ~152), **không** ở main. Vì vậy cache kết quả tool phải sống
   trong coordinator (nơi tool thật sự chạy). Main **không** giữ cache
   tool — IPC `cache:clear`/`cache:stats` ở main chỉ **forward** sang
   coordinator qua 2 method RPC mới (§5).
2. **Voice + WorkerPool sống ở main.** RealtimeClient giữ WebSocket và
   API key của provider realtime; main là nơi duy nhất giữ key (theo
   header `main.ts`). Pool xếp hàng các `chat:send`/job nền để nhiều bot
   không tranh nhau chạy cùng lúc.
3. **Agent loop không đổi.** `AgentRunner` gọi `tool.execute()` trực
   tiếp, không qua `registry.execute()` (loop là file chỉ-đọc của worker
   khác). Cache được móc bằng cách **bọc (decorate) `execute` của từng
   tool read-only lúc đăng ký** trong `defaultToolFactory` (§5, option A)
   — không cần sửa `loop.ts`.

```
Renderer (ChatView / SettingsView)
  │ IPC (preload window.openBot)
  ▼
Main process
  ├─ RealtimeClient (1/bot) ──wss──► provider realtime (OpenAI-shape)
  ├─ transcribeAudio ──POST──► {baseUrl}/audio/transcriptions
  ├─ WorkerPool ──► chat:send / job nền
  └─ IPC forward ──► CoordinatorClient.request('cache.stats' | 'cache.clear')
                      ▼
                    Coordinator con
                      └─ ToolRegistry + ToolResultCache (singleton/process)
                         └─ AgentRunner → tool.execute() (đã bọc cache)
```

## 2. Main process — khởi tạo singleton (`apps/desktop/src/main/main.ts`)

Thêm vào khu vực khai báo module (gần `let coordinator`, dòng ~177).
Không tạo trong handler — phải là singleton cả đời app.

```typescript
import { RealtimeClient, transcribeAudio } from '@open-bot/core/dist/voice/index';
import type { RealtimeConfig } from '@open-bot/core/dist/voice/index';
import { WorkerPool } from '@open-bot/core/dist/perf/index';

// --- v0.4 worker 3: voice + hiệu năng (singleton cả đời app) ---

/** Pool chạy chat:send / job nền. Size mặc định = min(CPU, 8). */
const workerPool = new WorkerPool({ size: 4, maxConcurrentToolExecs: 4 });

/** Một RealtimeClient cho mỗi bot đang gọi voice (key = botId). */
const voiceClients = new Map<string, RealtimeClient>();

/** Lấy URL realtime + key STT từ settings của provider mà bot đang dùng.
 *  Trả về null khi provider đó không cấu hình realtime/STT: UI phải ẩn
 *  hoặc disable nút voice (không tự đoán URL). */
function realtimeConfigFor(bot: BotConfig): { url: string; apiKey?: string; baseUrl: string } | null {
  const providerSettings = settings.providers[bot.providerId];
  if (!providerSettings) return null;
  // `realtimeUrl` là field MỚI trong ProviderSettings (thêm vào interface
  // ở main.ts, xem §2.1). Ví dụ OpenAI:
  //   wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview
  // Để trống = provider đó chưa hỗ trợ voice realtime.
  const url = (providerSettings as { realtimeUrl?: string }).realtimeUrl;
  if (!url) return null;
  return { url, apiKey: providerSettings.apiKey || undefined, baseUrl: providerSettings.baseUrl };
}
```

### 2.1. Thêm field vào `ProviderSettings` (main.ts, interface dòng ~60)

```typescript
export interface ProviderSettings {
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  /** WebSocket URL realtime (dạng OpenAI Realtime API). Để trống = không hỗ trợ voice. */
  realtimeUrl?: string;
}
```

`settingsForRenderer()` (dòng ~141) **không** được trả `realtimeUrl` hay
`apiKey` ra renderer — renderer chỉ biết "bot này có voice hay không"
qua IPC `voice:available` (§3) trả về boolean.

## 3. Main process — IPC handlers (thêm trong `registerIpcHandlers`, sau `chat:send`)

```typescript
// --- v0.4 worker 3: voice ---

/** Renderer hỏi bot này có gọi voice được không (có realtimeUrl + key). */
ipcMain.handle('voice:available', (_event: unknown, payload: { botId: string }) => {
  const bot = settings.bots.find((b) => b.id === payload.botId);
  if (!bot) return { available: false };
  return { available: realtimeConfigFor(bot) !== null };
});

ipcMain.handle('voice:connect', async (_event: unknown, payload: { botId: string }) => {
  const bot = settings.bots.find((b) => b.id === payload.botId);
  if (!bot) return { ok: false, error: 'Không tìm thấy bot.' };
  const cfg = realtimeConfigFor(bot);
  if (!cfg) return { ok: false, error: 'Provider này chưa cấu hình voice realtime.' };
  const win = BrowserWindow.getAllWindows()[0];
  if (voiceClients.get(bot.id)?.isConnected()) return { ok: true };

  const client = new RealtimeClient({
    onTranscript: (e) => {
      // Transcript về renderer để hiện chữ theo thời gian thực.
      win?.webContents.send('voice:transcript', { botId: bot.id, text: e.text, isFinal: e.isFinal });
    },
    onAudio: (e) => {
      // PCM16 bytes → renderer phát qua AudioContext (base64 qua IPC).
      win?.webContents.send('voice:audio', {
        botId: bot.id,
        audioBase64: Buffer.from(e.audio).toString('base64'),
      });
    },
    onToolCall: (call) => {
      // Model realtime muốn gọi tool: chạy như một lượt agent thường
      // (qua coordinator) rồi đọc kết quả lại cho model. V0.4 chỉ
      // forward về renderer để hiển thị; thực thi tool trong voice
      // call là việc của mốc sau (cần response.function_call_output).
      win?.webContents.send('voice:toolcall', { botId: bot.id, call });
    },
    onError: (err) => {
      win?.webContents.send('voice:error', { botId: bot.id, message: err.message });
    },
  });
  voiceClients.set(bot.id, client);
  try {
    const config: RealtimeConfig = {
      url: cfg.url,
      apiKey: cfg.apiKey,
      model: bot.model,
      instructions: bot.systemPrompt,
    };
    await client.connect(config);
    return { ok: true };
  } catch (err) {
    voiceClients.delete(bot.id);
    return { ok: false, error: err instanceof Error ? err.message : 'Không kết nối được voice.' };
  }
});

/** Renderer gửi từng frame PCM16 (16 kHz mono) thu qua AudioWorklet. */
ipcMain.on('voice:audio', (_event: unknown, payload: { botId: string; audioBase64: string }) => {
  const client = voiceClients.get(payload.botId);
  if (!client?.isConnected()) return;
  try {
    client.sendAudio(new Uint8Array(Buffer.from(payload.audioBase64, 'base64')));
  } catch {
    // Gửi khi rớt mạng: bỏ frame, không crash main. Reconnect (tối đa
    // 3 lần, backoff) đã nằm trong RealtimeClient.
  }
});

/** Kết thúc câu nói: commit buffer + xin model trả lời. */
ipcMain.handle('voice:commit', (_event: unknown, payload: { botId: string }) => {
  const client = voiceClients.get(payload.botId);
  if (!client?.isConnected()) return { ok: false, error: 'Chưa kết nối voice.' };
  client.commitAudio();
  client.requestResponse();
  return { ok: true };
});

ipcMain.handle('voice:disconnect', (_event: unknown, payload: { botId: string }) => {
  voiceClients.get(payload.botId)?.disconnect();
  voiceClients.delete(payload.botId);
  return { ok: true };
});

/** Voice memo: renderer thu bằng MediaRecorder (webm/opus), gửi bytes
 *  lên đây, main gọi STT của provider rồi trả text về. */
ipcMain.handle(
  'voice:memo-transcribe',
  async (_event: unknown, payload: { botId: string; audioBase64: string }) => {
    const bot = settings.bots.find((b) => b.id === payload.botId);
    if (!bot) return { ok: false, error: 'Không tìm thấy bot.' };
    const providerSettings = settings.providers[bot.providerId];
    if (!providerSettings?.baseUrl) {
      return { ok: false, error: 'Provider này chưa cấu hình endpoint STT.' };
    }
    const bytes = Buffer.from(payload.audioBase64, 'base64');
    if (bytes.length === 0) return { ok: false, error: 'File ghi âm rỗng.' };
    if (bytes.length > 25 * 1024 * 1024) {
      return { ok: false, error: 'File ghi âm quá lớn (tối đa 25 MB).' };
    }
    try {
      const text = await transcribeAudio(new Uint8Array(bytes), {
        baseUrl: providerSettings.baseUrl,
        apiKey: providerSettings.apiKey || undefined,
        // Model STT lấy từ defaultModel khi provider là Whisper-compatible;
        // nếu provider không có STT thì endpoint trả 404 → báo lỗi rõ.
        model: providerSettings.defaultModel || undefined,
      });
      return { ok: true, text };
    } catch (err) {
      // Không log apiKey; message của transcribeAudio đã không chứa key.
      return { ok: false, error: err instanceof Error ? err.message : 'Không chuyển được giọng nói thành text.' };
    }
  },
);

// --- v0.4 worker 3: hiệu năng ---

/** Snapshot pool + cache cho mục Hiệu năng trong Settings (§6). */
ipcMain.handle('perf:stats', async () => {
  const poolStats = workerPool.stats();
  let cacheStats: unknown = null;
  try {
    cacheStats = await getCoordinator().request('cache.stats', {});
  } catch {
    cacheStats = null; // coordinator chưa chạy / chưa hỗ trợ → UI hiện "—"
  }
  return { ok: true, pool: poolStats, cache: cacheStats };
});

ipcMain.handle('cache:clear', async () => {
  try {
    await getCoordinator().request('cache.clear', {});
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Không xoá được cache.' };
  }
});
```

> Lưu ý `getCoordinator().request(...)`: `CoordinatorClient` hiện có
> `request<T>(method, params)` public hay không thì kiểm tra ở
> `packages/core/src/coordinator/client.ts` (dòng ~190 `this.request(...)`
> bên trong `createBot`/`run`). Nếu `request` là private, điều phối viên
> thêm 2 method public `cacheStats()` / `clearCache()` vào client, gọi
> `request('cache.stats' | 'cache.clear', {})` — xem §5.

### 3.1. `chat:send` đi qua WorkerPool (sửa 1 chỗ trong handler hiện có)

Trong handler `chat:send` (dòng ~533), bọc phần gọi coordinator bằng
pool để nhiều bot không chạy tràn lan; UI vẫn nhận event như cũ qua
`routeCoordinatorEvent`. Chỉ thay phần `try { ... getCoordinator().run ... }`:

```typescript
try {
  // v0.4: chat đi qua WorkerPool (tối đa N lượt chạy song song).
  const result = await workerPool.submit(
    () => getCoordinator().run(bot.id, text),
    { label: `chat:${bot.id}` },
  ).promise;
  const replyText = result.text ?? '';
  // ... phần còn lại giữ nguyên (assistantMsg, syncMessageToMemory, return)
}
```

## 4. Preload (`apps/desktop/src/main/preload.ts`)

Thêm vào `OpenBotApi` (sau `listSharedBots`) và vào object `openBot`
(cùng vị trí tương ứng). Đồng thời thêm 3 method vào interface
`OpenBotApi` trong `apps/desktop/src/renderer/global.d.ts` (bản mirror
phía renderer) — 2 file phải giống nhau.

```typescript
// --- v0.4 worker 3: voice ---
voiceAvailable: (botId: string) => Promise<{ available: boolean }>;
voiceConnect: (botId: string) => Promise<{ ok: boolean; error?: string }>;
voiceSendAudio: (botId: string, audioBase64: string) => void;
voiceCommit: (botId: string) => Promise<{ ok: boolean; error?: string }>;
voiceDisconnect: (botId: string) => Promise<{ ok: boolean }>;
transcribeMemo: (botId: string, audioBase64: string) => Promise<{ ok: boolean; text?: string; error?: string }>;
onVoiceTranscript: (cb: (payload: { botId: string; text: string; isFinal: boolean }) => void) => () => void;
onVoiceAudio: (cb: (payload: { botId: string; audioBase64: string }) => void) => () => void;
onVoiceError: (cb: (payload: { botId: string; message: string }) => void) => () => void;
onVoiceToolCall: (cb: (payload: { botId: string; call: unknown }) => void) => () => void;
// --- v0.4 worker 3: hiệu năng ---
getPerfStats: () => Promise<{ ok: boolean; pool?: unknown; cache?: unknown }>;
clearCache: () => Promise<{ ok: boolean; error?: string }>;
```

```typescript
// Trong object `openBot` (dùng sẵn helper `subscribe` ở preload.ts):
voiceAvailable: (botId) => ipcRenderer.invoke('voice:available', { botId }),
voiceConnect: (botId) => ipcRenderer.invoke('voice:connect', { botId }),
voiceSendAudio: (botId, audioBase64) => ipcRenderer.send('voice:audio', { botId, audioBase64 }),
voiceCommit: (botId) => ipcRenderer.invoke('voice:commit', { botId }),
voiceDisconnect: (botId) => ipcRenderer.invoke('voice:disconnect', { botId }),
transcribeMemo: (botId, audioBase64) => ipcRenderer.invoke('voice:memo-transcribe', { botId, audioBase64 }),
onVoiceTranscript: (cb) => subscribe('voice:transcript', cb),
onVoiceAudio: (cb) => subscribe('voice:audio', cb),
onVoiceError: (cb) => subscribe('voice:error', cb),
onVoiceToolCall: (cb) => subscribe('voice:toolcall', cb),
getPerfStats: () => ipcRenderer.invoke('perf:stats'),
clearCache: () => ipcRenderer.invoke('cache:clear'),
```

Không expose thêm gì khác. Tuyệt đối không expose `apiKey`,
`realtimeUrl`, hay `ipcRenderer` trực tiếp.

## 5. Coordinator — móc cache vào registry (không sửa `loop.ts`)

### 5.1. Singleton cache + method RPC mới

Trong `packages/core/src/coordinator/coordinator.ts`, gần
`defaultToolFactory` (dòng ~123), thêm singleton cache của tiến trình
coordinator (nơi duy nhất tool chạy):

```typescript
import { ToolResultCache, SUGGESTED_CACHEABLE_TOOLS } from '../perf/index';

/** Cache kết quả tool của tiến trình coordinator. TTL 5 phút, tối đa 200 entry. */
const toolResultCache = new ToolResultCache({ defaultTtlMs: 5 * 60 * 1000, maxEntries: 200 });
```

Trong `defaultToolFactory`, thay dòng `const registry = new toolsMod.ToolRegistry();`
bằng bản gắn cache, và **bọc `execute` của tool read-only** (vì
`AgentRunner` gọi `tool.execute()` trực tiếp — `registry.execute()` chỉ
dùng khi gọi registry trực tiếp, xem §5.2):

```typescript
const registry = new toolsMod.ToolRegistry({
  cache: toolResultCache,
  cacheableTools: [...SUGGESTED_CACHEABLE_TOOLS],
});
// AgentRunner gọi tool.execute() trực tiếp nên phải bọc execute của
// tool read-only tại đây thì cache mới có tác dụng (không sửa loop.ts).
for (const tool of registry.list()) {
  if (!SUGGESTED_CACHEABLE_TOOLS.includes(tool.definition.name)) continue;
  const originalExecute = tool.execute.bind(tool);
  tool.execute = async (args, ctx) => {
    const cached = toolResultCache.get(tool.definition.name, args);
    if (cached !== undefined) return cached;
    const output = await originalExecute(args, ctx);
    toolResultCache.set(tool.definition.name, args, output);
    return output;
  };
}
```

> Ràng buộc: `SUGGESTED_CACHEABLE_TOOLS` chỉ chứa tool read-only
> (`read_file`, `list_files`, `glob`, `grep`, `git_status`, `git_diff`,
> `web_search`, `web_fetch`, `http_get`). **Không** thêm `write_file`,
> `shell_exec`, `git_commit`, `delete_file`, hay bất kỳ tool plugin/MCP
> nào vào danh sách này nếu chưa kiểm tra nó là read-only. Tool nào ném
> lỗi thì không cache (chỉ `execute` thành công mới `set`).

Thêm 2 method vào `CoordinatorMethod` (`packages/core/src/coordinator/types.ts`)
và xử lý trong coordinator (nơi dispatch `switch (method)`):

```typescript
// types.ts — thêm vào union CoordinatorMethod:
| 'cache.stats'
| 'cache.clear'
```

```typescript
// coordinator.ts — trong dispatcher, cạnh 'ping' / 'daemonStatus':
case 'cache.stats':
  return toolResultCache.stats();
case 'cache.clear':
  toolResultCache.clear();
  return { cleared: true };
```

### 5.2. Khi nào dùng `registry.execute()`?

`registry.execute(name, args, ctx)` (mới ở worker 3) dùng cho code **gọi
registry trực tiếp** (test, script nội bộ, tool gọi tay từ main qua RPC).
Agent chạy thường thì đi qua lớp bọc ở §5.1, không cần gọi
`registry.execute()`. Hai đường đều dùng chung một `ToolResultCache`
nên không double-cache.

## 6. Renderer — UI

### 6.1. ChatView: nút voice call + voice memo (`components/ChatView.tsx`)

Hiện `ChatView` có `textarea` + nút gửi (dòng ~83–96). Thêm 2 nút cạnh
nút gửi, và 1 dòng trạng thái voice. Renderer **không** giữ key hay
WebSocket — mọi thứ qua `window.openBot`.

```tsx
import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/useT';

// --- trong component ChatView (thêm state; props giữ nguyên) ---
const t = useT();
const [voiceAvailable, setVoiceAvailable] = useState(false);
const [voiceOn, setVoiceOn] = useState(false);
const [voiceText, setVoiceText] = useState(''); // transcript trực tiếp
const [memoRecording, setMemoRecording] = useState(false);
const [memoBusy, setMemoBusy] = useState(false);
const mediaRecorderRef = useRef<MediaRecorder | null>(null);
const audioCtxRef = useRef<AudioContext | null>(null);

useEffect(() => {
  if (!bot) return;
  let alive = true;
  window.openBot.voiceAvailable(bot.id).then((r) => {
    if (alive) setVoiceAvailable(r.available);
  });
  const offTranscript = window.openBot.onVoiceTranscript(({ botId, text, isFinal }) => {
    if (botId !== bot.id) return;
    setVoiceText(text);
    if (isFinal) setInput((prev) => (prev ? prev + ' ' : '') + text);
  });
  const offAudio = window.openBot.onVoiceAudio(({ botId, audioBase64 }) => {
    if (botId !== bot.id) return;
    // PCM16 24 kHz mono → phát ra loa.
    const bytes = Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0));
    const pcm = new Int16Array(bytes.buffer);
    const ctx = (audioCtxRef.current ??= new AudioContext({ sampleRate: 24000 }));
    const buf = ctx.createBuffer(1, pcm.length, 24000);
    const out = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start();
  });
  const offError = window.openBot.onVoiceError(({ botId, message }) => {
    if (botId !== bot.id) return;
    setVoiceOn(false);
    setVoiceText('');
    // Hiện lỗi bằng cơ chế lỗi sẵn có của ChatView/App (không alert).
    onVoiceError?.(message);
  });
  return () => {
    alive = false;
    offTranscript();
    offAudio();
    offError();
    window.openBot.voiceDisconnect(bot.id);
  };
}, [bot?.id]);

// Thu mic PCM16 16 kHz bằng AudioWorklet (worklet file riêng,
// xem §6.2) rồi gửi từng frame qua IPC voice:audio.
async function toggleVoice() {
  if (!bot) return;
  if (voiceOn) {
    await window.openBot.voiceDisconnect(bot.id);
    setVoiceOn(false);
    return;
  }
  const res = await window.openBot.voiceConnect(bot.id);
  if (!res.ok) {
    onVoiceError?.(res.error ?? t('voice.connectError'));
    return;
  }
  setVoiceOn(true);
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const ctx = new AudioContext({ sampleRate: 16000 });
  await ctx.audioWorklet.addModule('pcm-capture.worklet.js'); // xem §6.2
  const node = new AudioWorkletNode(ctx, 'pcm-capture');
  node.port.onmessage = (e: MessageEvent<{ audioBase64: string }>) => {
    window.openBot.voiceSendAudio(bot.id, e.data.audioBase64);
  };
  ctx.createMediaStreamSource(stream).connect(node);
  // Dừng thu khi bấm lại nút: disconnect ở trên + đóng ctx/stream
  // (lưu ctx/stream vào ref để dọn — code đầy đủ trong PR tích hợp).
}

// Voice memo: thu webm/opus bằng MediaRecorder, gửi lên STT, text về
// chèn vào ô nhập để người dùng sửa rồi mới gửi.
async function toggleMemo() {
  if (!bot) return;
  if (memoRecording) {
    mediaRecorderRef.current?.stop(); // onstop ở dưới gửi đi
    setMemoRecording(false);
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  rec.onstop = async () => {
    stream.getTracks().forEach((tr) => tr.stop());
    setMemoBusy(true);
    try {
      const buf = await new Blob(chunks).arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      const res = await window.openBot.transcribeMemo(bot.id, b64);
      if (res.ok && res.text) {
        setInput((prev) => (prev ? prev + ' ' : '') + res.text);
      } else {
        onVoiceError?.(res.error ?? t('voice.memoError'));
      }
    } finally {
      setMemoBusy(false);
    }
  };
  mediaRecorderRef.current = rec;
  rec.start();
  setMemoRecording(true);
}
```

JSX — thêm vào `.chat-input`, cạnh nút gửi hiện có:

```tsx
<div className="chat-input">
  <textarea /* ...giữ nguyên... */ />
  {voiceAvailable && (
    <button
      className="btn"
      onClick={toggleVoice}
      disabled={status !== 'idle'}
      title={t('voice.callHint')}
      aria-pressed={voiceOn}
    >
      {voiceOn ? t('voice.stopCall') : t('voice.startCall')}
    </button>
  )}
  <button
    className="btn"
    onClick={toggleMemo}
    disabled={status !== 'idle' || memoBusy}
    title={t('voice.memoHint')}
  >
    {memoRecording ? t('voice.memoStop') : t('voice.memoRecord')}
  </button>
  <button className="btn" onClick={send} disabled={status !== 'idle' || !input.trim()}>
    {t('chat.send')}
  </button>
</div>
{voiceOn && voiceText && <div className="voice-transcript">{voiceText}</div>}
```

> `onVoiceError` là prop mới của `ChatView` (`(message: string) => void`,
> optional) — `App.tsx` truyền vào để hiện lỗi theo luồng lỗi sẵn có.
> Khi `voiceOn` mà người dùng bấm gửi text thường thì vẫn gửi như cũ;
> voice call và chat text không loại nhau.

### 6.2. AudioWorklet PCM capture (`apps/desktop/src/renderer/pcm-capture.worklet.js`)

File mới, load bằng `audioWorklet.addModule` (đường dẫn tương đối theo
cách app serve renderer — kiểm tra `vite` config của desktop trước khi
đặt đường dẫn cuối). Chuyển mic float32 → PCM16 16 kHz, gửi base64
từng frame ~100 ms:

```js
// pcm-capture.worklet.js — chạy trong AudioWorklet, không có DOM.
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    const pcm = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.buffer.push(...new Uint8Array(pcm.buffer));
    // ~100 ms ở 16 kHz mono 16-bit = 3200 bytes.
    if (this.buffer.length >= 3200) {
      const chunk = this.buffer.splice(0, 3200);
      let binary = '';
      for (let i = 0; i < chunk.length; i++) binary += String.fromCharCode(chunk[i]);
      this.port.postMessage({ audioBase64: btoa(binary) });
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor);
```

Nếu Worklet không kịp cho v0.4 thì **fallback được chấp nhận**: chỉ
ship voice memo (MediaRecorder, §6.1) và ẩn nút voice call khi
`voiceAvailable` đúng nhưng worklet chưa sẵn — nhưng phải ghi rõ trong
PR là call realtime tạm ẩn, không được để nút bấm mà không chạy.

### 6.3. SettingsView: mục Hiệu năng (`components/SettingsView.tsx`)

Thêm một `<section>` sau mục ngôn ngữ (dùng `useT`, `useEffect` load
kèm settings, nút refresh + nút xoá cache). Kiểu dữ liệu trả về của
`getPerfStats` (định nghĩa trong `renderer/types.ts`):

```typescript
export interface PerfStatsView {
  pool: {
    workers: number;
    busyWorkers: number;
    idleWorkers: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
    effectiveConcurrency: number;
  };
  cache: {
    entries: number;
    hits: number;
    misses: number;
    evictions: number;
    maxEntries: number;
  } | null;
}
```

```tsx
const [perf, setPerf] = useState<PerfStatsView | null>(null);
const [perfError, setPerfError] = useState('');
const [clearing, setClearing] = useState(false);

async function loadPerf() {
  try {
    const res = await window.openBot.getPerfStats();
    if (res.ok) {
      setPerf({
        pool: res.pool as PerfStatsView['pool'],
        cache: (res.cache as PerfStatsView['cache']) ?? null,
      });
      setPerfError('');
    } else {
      setPerfError(t('perf.loadError'));
    }
  } catch {
    setPerfError(t('perf.loadError'));
  }
}
useEffect(() => { loadPerf(); }, []);

async function onClearCache() {
  setClearing(true);
  try {
    const res = await window.openBot.clearCache();
    if (res.ok) await loadPerf();
    else setPerfError(res.error ?? t('perf.clearError'));
  } finally {
    setClearing(false);
  }
}

// JSX (trong SettingsView, sau section ngôn ngữ):
<section>
  <h2>{t('perf.title')}</h2>
  {perfError && <p className="error">{perfError}</p>}
  {perf && (
    <div>
      <p>{t('perf.workers', { busy: perf.pool.busyWorkers, total: perf.pool.workers })}</p>
      <p>{t('perf.queue', { pending: perf.pool.pending, running: perf.pool.running })}</p>
      <p>{t('perf.jobs', { done: perf.pool.completed, failed: perf.pool.failed })}</p>
      <p>
        {perf.cache
          ? t('perf.cache', { entries: perf.cache.entries, hits: perf.cache.hits, misses: perf.cache.misses })
          : t('perf.cacheUnavailable')}
      </p>
      <button className="btn" onClick={loadPerf}>{t('perf.refresh')}</button>
      <button className="btn" onClick={onClearCache} disabled={clearing}>
        {clearing ? t('perf.clearing') : t('perf.clearCache')}
      </button>
      <p className="hint">{t('perf.cacheHint')}</p>
    </div>
  )}
</section>
```

`window.openBot.getPerfStats()` trong preload trả `pool`/`cache` dạng
`unknown` — ép kiểu ở renderer như trên (đã định nghĩa
`PerfStatsView` trong `renderer/types.ts`).

## 7. i18n — khóa cần thêm (`locales/vi.json`, `locales/en.json`)

Khóa dạng flat `section.key` như file locale hiện tại. Thêm đủ cả 2
file, thiếu 1 bên là test `i18n.test.mjs` fail.

| Khóa | vi | en |
|---|---|---|
| `voice.startCall` | Gọi thoại | Start voice call |
| `voice.stopCall` | Dừng gọi | Stop voice call |
| `voice.callHint` | Nói chuyện trực tiếp với bot | Talk to the bot live |
| `voice.memoRecord` | Ghi voice memo | Record voice memo |
| `voice.memoStop` | Dừng ghi | Stop recording |
| `voice.memoHint` | Ghi âm ngắn, chuyển thành text để gửi | Record a short memo, transcribed to text |
| `voice.connectError` | Không kết nối được voice. | Could not connect to voice. |
| `voice.memoError` | Không chuyển được giọng nói thành text. | Could not transcribe the voice memo. |
| `perf.title` | Hiệu năng | Performance |
| `perf.workers` | Worker: {busy}/{total} đang bận | Workers: {busy}/{total} busy |
| `perf.queue` | Hàng đợi: {pending} chờ, {running} đang chạy | Queue: {pending} waiting, {running} running |
| `perf.jobs` | Job xong: {done}, lỗi: {failed} | Jobs done: {done}, failed: {failed} |
| `perf.cache` | Cache tool: {entries} mục, trúng {hits}, trượt {misses} | Tool cache: {entries} entries, {hits} hits, {misses} misses |
| `perf.cacheUnavailable` | Cache tool chưa khả dụng (coordinator chưa chạy). | Tool cache unavailable (coordinator not running). |
| `perf.cacheHint` | Chỉ kết quả tool chỉ-đọc mới được cache; tool ghi file/chạy lệnh không cache. | Only read-only tool results are cached; file writes and shell commands are never cached. |
| `perf.refresh` | Làm mới | Refresh |
| `perf.clearCache` | Xoá cache | Clear cache |
| `perf.clearing` | Đang xoá… | Clearing… |
| `perf.loadError` | Không tải được trạng thái hiệu năng. | Could not load performance status. |
| `perf.clearError` | Không xoá được cache. | Could not clear the cache. |

Kiểm tra `useT` hỗ trợ tham số `{busy}` — nếu chưa, xem cách
`common.error` truyền `{message}` trong `SettingsView.tsx` (dòng ~97)
và làm theo cùng cơ chế.

## 8. Lưu ý import — đọc kỹ

`packages/core/src/index.ts` **không** export voice/perf (file này nằm
ngoài phạm vi worker 3, cấm sửa). Vì vậy main/coordinator import theo
đường dẫn sâu — đã có tiền lệ trong repo
(`packages/tools/src/mcpTools.ts` import `@open-bot/core/dist/mcp/client`):

```typescript
import { RealtimeClient, transcribeAudio } from '@open-bot/core/dist/voice/index';
import { WorkerPool, ToolResultCache } from '@open-bot/core/dist/perf/index';
```

Điều này yêu cầu `@open-bot/core` đã được build (`dist/` có
`voice/`, `perf/`) trước khi build desktop — build script của desktop
hiện đã build core trước (theo `package.json` root: core → tools →
desktop), nên chỉ cần kiểm tra thứ tự đó còn đúng. **Follow-up cho điều
phối viên:** thêm voice/perf vào export của `packages/core/src/index.ts`
ở mốc sau để bỏ deep import (việc 1 dòng, nhưng ngoài phạm vi worker 3).

## 9. Kiểm chứng sau khi nối

1. `npx tsc --noEmit -p packages/core/tsconfig.json` và
   `packages/tools/tsconfig.json` — pass.
2. `npm run build --workspace=@open-bot/core` rồi
   `--workspace=@open-bot/tools` rồi build desktop — pass.
3. `node --test tests/voice.test.mjs tests/perf.test.mjs` — 23/23 pass
   (đã pass trước khi nối; chạy lại sau khi nối để chắc không ai sửa
   lõi).
4. Chạy tay (không có API key thật — dùng mock/Ollama local):
   - Voice memo với Ollama-only: phải báo lỗi STT rõ ràng (Ollama
     không có `/v1/audio/transcriptions`), không crash.
   - Voice memo với provider có STT (OpenAI key test của người dùng):
     ghi 3 giây → text chèn vào ô nhập.
   - Voice call với OpenAI realtime key: bấm gọi → transcript hiện
     dần; ngắt mạng → client tự reconnect tối đa 3 lần.
   - Settings → Hiệu năng: số worker/queue/cache hiện đúng; gọi
     `read_file` 2 lần giống nhau → `hits` tăng; bấm Xoá cache →
     `entries` về 0.
5. Không có secret/key nào lọt vào log, file, hay IPC trả về renderer
   (grep `apiKey|realtimeUrl` trong output IPC).

## 10. Giới hạn còn tồn đọng (không giấu)

- **Realtime nội bộ của xAI/Grok Bot không tái tạo được**: phân tích
  tĩnh chỉ thấy endpoint `wss://api.x.ai/`, không có spec giao thức.
  `RealtimeClient` dùng chuẩn mở dạng OpenAI Realtime API làm hợp
  đồng; provider nào theo chuẩn đó thì cắm được, provider khác cần
  adapter riêng.
- **Tool call trong voice call chưa thực thi**: `onToolCall` hiện chỉ
  forward về renderer để hiển thị; để model realtime gọi tool thật cần
  gửi `response.function_call_output` + chạy tool qua coordinator —
  việc mốc sau.
- **Voice memo phụ thuộc STT của provider**: endpoint
  `/v1/audio/transcriptions` phải tồn tại ở provider người dùng chọn.
  Ollama mặc định không có endpoint này → memo báo lỗi rõ thay vì
  im lặng.
- **Thu PCM16 cần AudioWorklet**: nếu worklet chưa nối xong thì nút
  gọi thoại phải ẩn (fallback ở §6.2), chỉ ship voice memo.
- **Cache chỉ có tác dụng khi tool chạy qua coordinator** (§5.1): tool
  gọi từ nơi khác (script ngoài, MCP trực tiếp) không qua cache.
- **Pool ở main chỉ xếp hàng `chat:send`/job main tạo**: job chạy
  trong coordinator (agent loop, subagent) không qua pool này; giới
  hạn bot đồng thời phía coordinator là việc riêng.
- **Không có API key thật để test live**: mọi test voice/perf đều bằng
  mock WebSocket + mock HTTP server; chưa từng gọi realtime/STT thật.
