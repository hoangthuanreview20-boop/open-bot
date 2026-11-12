# Kiến trúc open-bot

## Tổng quan

open-bot là một ứng dụng desktop (Electron) chạy hoàn toàn trên máy người dùng — **local-first, không có backend cloud**. Người dùng mang API key của mình, app gọi trực tiếp tới provider AI mà họ chọn.

```
┌─────────────────────────────────────────────────────────────┐
│  apps/desktop (Electron)                                    │
│  ┌──────────────┐   IPC    ┌────────────────────────────┐  │
│  │ Renderer     │ ◄──────► │ Main process               │  │
│  │ (UI: chat,   │          │ - AgentRunner              │  │
│  │  settings,   │          │ - Quản lý cửa sổ / tray    │  │
│  │  approvals)  │          │ - Lưu API key (local)      │  │
│  └──────────────┘          └──────┬─────────────┬─────────┘  │
└──────────────────────────────────┼─────────────┼────────────┘
                                   │             │
                    ┌──────────────▼──┐  ┌──────▼─────────────┐
                    │ packages/core   │  │ packages/tools     │
                    │ - Agent loop    │  │ - Sandbox          │
                    │ - Provider      │  │ - Tools: shell,    │
                    │   abstraction   │  │   file, web, ...   │
                    │ - Memory SQLite │  │                    │
                    └──────┬──────────┘  └────────────────────┘
                           │
                    ┌──────▼──────────┐
                    │ Provider AI     │  (OpenAI / Anthropic /
                    │ (qua API key    │   Gemini / xAI Grok /
                    │  của người dùng)│   Ollama local, ...)
                    └─────────────────┘
```

## Các thành phần

### 1. `apps/desktop` — Electron app

- **Main process:** điểm vào của ứng dụng. Khởi tạo và sở hữu `AgentRunner`, quản lý cửa sổ, tray icon (chạy nền, luôn bật), và lưu trữ API key an toàn trên máy (OS keychain / file local, không gửi đi đâu khác).
- **Renderer process:** giao diện người dùng — khung chat, danh sách nhiệm vụ, màn hình Settings (chọn provider/model, nhập API key), và màn hình phê duyệt (approval).
- **IPC:** renderer và main trao đổi qua IPC với các kênh hẹp, có kiểm chứng (validated channel). Renderer không bao giờ cầm trực tiếp API key hay gọi thẳng provider.

### 2. `packages/core` — lõi agent

- **Agent loop:** nhận nhiệm vụ từ người dùng → gọi provider → nhận về tool call / text → thực thi tool (qua `packages/tools`) → đưa kết quả trở lại provider → lặp lại cho tới khi hoàn thành → trả lời người dùng.
- **Provider abstraction:** một interface chung (`Provider`) cho mọi nhà cung cấp. Mỗi provider (OpenAI, Anthropic, Gemini, xAI Grok, Ollama...) chỉ là một adapter triển khai interface này: cùng cách gửi messages, nhận streaming, gọi tool. Nhờ đó đổi provider/model không cần sửa agent loop.
- **Memory (SQLite):** lịch sử trò chuyện, ghi nhớ dài hạn và trạng thái nhiệm vụ lưu trong file SQLite local trên máy người dùng. Không có dữ liệu nào rời khỏi máy ngoài request tới provider mà người dùng đã chọn.

### 3. `packages/tools` — sandbox & tools

- **Sandbox:** mọi tool chạy trong môi trường giới hạn — giới hạn thư mục được phép truy cập, giới hạn lệnh shell, timeout, giới hạn tài nguyên. Tool không được chạy tùy ý ngoài sandbox.
- **Tools:** shell, đọc/ghi file, tìm kiếm web, ... Mỗi tool khai báo rõ schema đầu vào, mô tả, và mức độ rủi ro của nó.

## Luồng phê duyệt cho hành động nhạy cảm

Không phải hành động nào agent cũng được tự chạy. Các hành động nhạy cảm — ghi/sửa/xóa file, chạy lệnh shell, gửi request mạng, cài đặt phần mềm, truy cập dữ liệu ngoài thư mục làm việc — đều phải qua phê duyệt:

1. Agent đề xuất một tool call nhạy cảm → agent loop tạm dừng.
2. Main process gửi yêu cầu phê duyệt sang renderer, hiển thị đầy đủ: tool nào, tham số nào, tác động gì.
3. Người dùng **Cho phép / Từ chối** (có thể cho phép một lần, hoặc cho phép luôn cho loại hành động đó trong phiên).
4. Chỉ khi được phép, tool mới chạy trong sandbox; kết quả trả lại agent loop để tiếp tục.
5. Mọi lần phê duyệt / từ chối đều được ghi log local để người dùng kiểm tra lại.

Hành động chỉ đọc (đọc file trong thư mục làm việc, tra cứu memory) mặc định được phép; danh sách này có thể siết chặt trong Settings.

## Dữ liệu lưu local

| Dữ liệu | Vị trí | Ghi chú |
|---|---|---|
| API key | `settings.json` trong thư mục app data local (plaintext cho tới khi có vault ở v0.4) | Không commit, không gửi đi đâu ngoài provider đã chọn |
| Lịch sử chat, memory | SQLite local (`*.sqlite`, đã ignore khỏi git) | Chỉ đọc/ghi trên máy người dùng |
| Cấu hình app | Thư mục app data local | Provider/model mặc định, chính sách phê duyệt |
| Log | File log local | Có thể xóa bất cứ lúc nào |

Không có tài khoản người dùng, không có server trung tâm, không có telemetry mặc định. Request mạng duy nhất ra ngoài máy là request tới provider AI mà người dùng tự cấu hình (và các tool web mà người dùng phê duyệt, ví dụ tìm kiếm web).

### Ảnh đính kèm trong chat — lưu file + tham chiếu DB (v0.65, quyết định B)

Vấn đề (v0.63/v0.64): ảnh đính kèm tới được agent trong phiên (thumbnail ở bubble user) nhưng sau reload chỉ còn dòng metadata trong text — base64 không được lưu, vì `saveMessage` chỉ nhận text.

Quyết định: **(B) lưu file ảnh + tham chiếu trong DB** — không chọn (A) lưu base64 vào SQLite. Lý do:

- **DB không phình**: một tin có thể mang tới 20 MB ảnh; base64 phình thêm ~33% và nằm trong mọi bản backup/export của `memory.db`. File giữ DB chỉ là text.
- **Dọn dẹp được**: xoá thread/bot là xoá cả file (xem dưới); base64 trong DB thì chỉ có `VACUUM` mới thu hồi trang.
- **Tương thích ngược**: tin cũ (chỉ metadata line trong text, không có row đính kèm) hiện đúng như trước; tin mới có cả ảnh thật.
- **Chi phí**: thêm một lần đọc file khi load history có ảnh — chấp nhận được (tối đa 5 ảnh/tin, 50 tin/lần load, chỉ khi UI yêu cầu).

Cách làm:

- File: `<workspaceDir>/.open-bot/attachments/<messageId>/<idx>.<ext>` (`png`/`jpg`/`gif`/`webp` theo mime; `messageId` là UUID do `saveMessage` sinh, `fileName` trong DB luôn là `<idx>.<ext>` do mình sinh — không tin tên file từ ngoài).
- DB: bảng `message_attachments` (`messageId`, `botId`, `idx`, `name`, `mimeType`, `sizeBytes`, `fileName`) — một row/ảnh, KHÔNG chứa byte ảnh. Tạo bằng `CREATE TABLE IF NOT EXISTS` nên DB cũ tự có bảng khi mở lại.
- Ghi: `BotMemory.saveMessage(..., attachments?)` validate lại cap (`validateVisionAttachments` — 5 ảnh / 10 MB mỗi ảnh / 20 MB tổng, PNG/JPEG/GIF/WebP; sai là throw, không lưu gì) → ghi file trước → insert message + rows trong một transaction → lỗi thì xoá file vừa ghi (không bao giờ để lại tin nửa vời hay file mồ côi).
- Đọc: `getHistory`/`getThreadHistory` mặc định KHÔNG trả ảnh (text-only — seed context cho run, export, search giữ nguyên); chỉ khi `includeAttachments: true` (đường reload của UI: `chat:history` → `getHistory(..., true)`) mới đọc file thành base64 cho bubble hiển thị.
- Fail-closed khi load: file mất, byte không khớp `sizeBytes` trong row, mime lạ, hoặc file quá cap → attachment trả về `{ data: '', unavailable: true }` (đủ metadata để renderer hiện tên + ghi chú "không xem được", không throw, không ảnh vỡ).
- Không gửi lại ảnh cũ lên provider: `selectThreadHistory` lột `attachments` khỏi mọi message trước khi nạp làm context — ảnh cũ chỉ để hiển thị lại, không tốn token lượt sau.
- Dọn mồ côi: `deleteThread` / `deleteBotData` xoá cả rows + files của tin thuộc thread/bot đó; `BotMemory` quét một lần lúc khởi tạo để xoá thư mục file không còn row nào trỏ tới (crash hoặc DB restore từ backup cũ).
- Tin chỉ có ảnh (text rỗng): tiêu đề thread lấy từ tên ảnh đầu tiên (`📷 <tên>`) thay vì chuỗi rỗng.
- **Đường vào khác ngoài desktop chat (v0.89a)**: trước v0.89a chỉ `chat:send` đưa được ảnh tới agent — Local API `POST /v1/bots/:id/run` bắt buộc text non-empty và không có trường `attachments`, headless CLI không có cờ ảnh nào, nên script/app ngoài và terminal không bao giờ cho agent xem ảnh. Nay cả hai đường đều nối vào đúng kênh vision (`validateVisionAttachments` + gate `providerSupportsVision` của loop, fail-closed): Local API nhận thêm `"attachments": [{mimeType, data (base64), name?}]` (sai → 400 trước khi chạy; text rỗng + ảnh = tin chỉ-ảnh hợp lệ; giới hạn thực tế: body JSON cap 1 MB nên chỉ ~1 ảnh nhỏ mỗi request — ảnh lớn vẫn qua composer desktop), CLI nhận `--image <file>` (lặp lại được, tối đa 5; đuôi PNG/JPEG/GIF/WebP; file không đọc được / đuôi sai → exit 1 trước khi chạy bot). Cả hai đều đi qua `RunParams.attachments` → loop → provider render (Gemini `inlineData`, OpenAI `image_url`, Anthropic `image`, Ollama native). WebSocket stream (`?text=`) vẫn text-only (query string không chở base64) — giới hạn đã biết.
- **Kiểm chứng live lần đầu (v0.89a, 2026-11-11)**: `GeminiProvider` thật qua proxy local (port 8765, key chỉ qua surrogate, không chạm file/log) gửi ảnh vuông đỏ 64x64 + hỏi "Màu chủ đạo của hình này là gì?" → gemini-2.5-flash trả lời "Đỏ" trong 2001 ms, usage 278 in / 2 out, upstream HTTP 200 — ảnh đi tới được model qua `inlineData`. Ollama `qwen2.5:0.5b` thật (127.0.0.1:11434) từ chối rõ trước khi gọi model. Test gated `tests/gemini-live-vision-v089a.test.mjs` (`OPENBOT_LIVE_GEMINI=1` + proxy up), test Ollama không gated (baseUrl cổng đóng để chứng minh guard chạy trước mọi fetch).

## Kiến trúc mở rộng (tầm nhìn platform)

Mục này mô tả **thiết kế để chứa tầm nhìn dài hạn** — platform lớn hơn
Grok Bot, đa ngôn ngữ, siêu mạnh mẽ (xem
[ROADMAP.md](ROADMAP.md), mục 2f). **v0.1 chưa cần có hết** các thành
phần dưới đây; v0.1 chỉ cần thiết kế sao cho sau này thêm vào được mà
không phải đập đi làm lại.

- **Tool registry (đăng ký tool động):** `packages/tools` giữ một registry
  trung tâm — tool mới được đăng ký lúc chạy (kèm schema, mô tả, mức rủi
  ro) thay vì hard-code trong agent loop. Thêm tool = đăng ký vào
  registry, không sửa code lõi.
- **Plugin system + MCP:** plugin là gói nạp thêm tool/kỹ năng cho agent,
  bật/tắt từng plugin trong Settings; MCP là cổng mở rộng chính ra dịch vụ
  ngoài. Marketplace (local trước) để duyệt, cài, gỡ plugin/MCP
  server/template.
- **i18n (đa ngôn ngữ):** mọi chuỗi hiển thị trong renderer đi qua file
  locale (bắt đầu tiếng Việt + tiếng Anh); thêm ngôn ngữ mới chỉ cần thêm
  một file locale, không sửa code UI. Agent làm việc được mọi ngôn ngữ qua
  model của provider.
- **Hiệu năng:** nhiệm vụ/agent chạy qua job queue với worker pool (chạy
  song song, giới hạn tài nguyên từng worker), kết quả tool được cache có
  thời hạn — để nhiều bot chạy song song mà giao diện vẫn mượt, app không
  ì ạch.
- **Hướng đa người dùng/team và API bên thứ ba:** về lâu dài, thêm lớp API
  local (HTTP/WebSocket) để app/script ngoài gọi được agent, và workspace
  team có phân quyền — xây trên nền local-first hiện tại (dữ liệu vẫn ở
  trên máy người dùng, key của ai người đó giữ), không thay thế nó.

## Nguyên tắc thiết kế

- **Local-first:** mất mạng tới provider thì app vẫn mở được, vẫn xem được lịch sử; chỉ không gọi được model mới.
- **Bring your own key:** open-bot không sở hữu model, không bán credit, không làm trung gian thu phí.
- **An toàn mặc định:** hành động nhạy cảm cần phê duyệt; sandbox giới hạn phạm vi tool.
- **Đổi provider dễ dàng:** thêm provider mới = thêm một adapter, không sửa agent loop hay UI chat.

## v0.2 — những gì đã triển khai (2026-11-08)

- **48 tool qua một ToolRegistry** (`packages/tools/src/registry.ts`):
  main process dựng một registry cho mỗi bot — 10 tool gốc + 8 tool
  code (glob, grep, delete, apply_diff, blame, diagnostics, semantic
  search xếp hạng từ khoá, x_search qua `site:x.com`) + 17 tool
  plan/task/goal/todo/project + 8 tool subagent + 5 tool MCP. Trùng tên
  bị từ chối lúc đăng ký (fail fast), không đợi tới giữa hội thoại.
- **i18n đầy đủ:** renderer dùng `t()` với locale `vi`/`en` (92 key mỗi
  bên, parity 1–1, kiểm tra bằng test); đổi ngôn ngữ trong Settings áp
  dụng ngay và lưu vào `settings.json` (`locale`, mặc định `vi`).
- **Plan/task/goal/todo/project:** bảng mới trong SQLite của BotMemory
  (`goals`, `todos`, `projects`, cột `tags` cho `tasks` kèm migration
  không vỡ DB v0.1); `PlanService` bọc CRUD; tool `project_set_updates`
  hiện chỉ lưu cờ, chưa có kênh gửi thật.
- **Subagent trong cùng process:** `AgentRunner` chạy agent con với cùng
  provider + tool, registry in-memory, timeout + AbortSignal; tool
  `ask_user` / `send_message_to_user` / `send_progress_update` /
  `send_final_summary` / `stop_agent` được loop xử lý trực tiếp từ
  `AgentEvents`. Main process nối `onAskUser` thành hộp thoại trong
  renderer (IPC `chat:ask-user` / `chat:ask-user-response`, timeout
  10 phút trả về chuỗi rỗng); `onProgress`/`onFinalSummary` hiện thành
  notice trong giao diện chat.
- **MCP client tự viết** (`packages/core/src/mcp/`): JSON-RPC 2.0 qua
  stdio và streamable HTTP, config theo workspace
  (`.open-bot/mcp.json`); mỗi lần gọi tool MCP mở kết nối mới rồi đóng
  (chưa giữ session dài); chưa có OAuth flow đầy đủ — chỉ header
  `Authorization` tĩnh trong config.
- **Giới hạn đã biết (ghi để v0.3–v0.4 xử lý):** 48 tool definitions
  chiếm ~5.500 token trong mỗi request — model local context nhỏ
  (mặc định 4.096 token của Ollama) sẽ bị lỗi 400; model local cần
  `num_ctx` ≥ 16.384 (xem docs/TESTING.md). Tối ưu dài hạn: lọc tool
  theo ngữ cảnh / rút gọn definition.

## v0.3 wave 1 — agent management, plugin system, MCP marketplace, team local (2026-11-08)

- **Agent management** (`packages/core/src/agent/`): 6 template dựng sẵn
  (Code, Research, Writing, Data, Automation, General);
  `cloneAgent` (bot mới với id + workspace riêng), `publishAgent` /
  `listPublished` / `installPublished` / `uninstallPublished` với
  marketplace local tại `<userData>/marketplace/agents.json`;
  `sanitizeConfig` chỉ giữ 7 field BotConfig — không rò API key.
  Main nối IPC `agents:clone` / `agents:publish` / `templates:list` /
  `marketplace:*`; renderer có `AgentMarketplaceView` + chọn template
  trong BotForm.
- **Plugin system** (`packages/tools/src/plugins/`): plugin = một thư mục
  có `manifest.json` (id, version semver, `main`, `permissions` khai báo
  `fs`/`shell`/`network`/`mcp`, allowlist `tools`) + code JS. Loader
  validate manifest, quét source tĩnh (chỉ cho Node built-in + relative,
  chặn npm package; capability nào không khai báo thì REJECT TOÀN BỘ
  plugin — fail-closed), validate từng tool bằng cùng
  `validateToolDefinition` của registry, wrap `execute` truncate output
  20.000 ký tự. `PluginManager` quét thư mục `<userData>/plugins`,
  plugin hỏng ghi vào `loadErrors()` không crash app, bật/tắt persist
  qua `enabled.json`. Main tạo một manager duy nhất lúc runtime đầu
  tiên, đăng ký tool plugin (enabled) vào registry của mỗi bot; tool
  trùng tên/lỗi bị bỏ qua kèm log, không làm sập bot.
  **Giới hạn:** plugin chạy in-process, `permissions` là kiểm soát khai
  báo + chặn lúc đăng ký qua quét source tĩnh, KHÔNG phải sandbox hệ
  điều hành — code cố tình obfuscate có thể lách quét text; chỉ cài
  plugin từ nguồn tin cậy. Sandbox process riêng là wave 2.
- **MCP marketplace** (`packages/core/src/mcp/marketplace.ts`): catalogue
  local 8 server mẫu thật qua `npx -y` (filesystem, memory, fetch,
  sqlite, git, brave-search, github, postgres); `install` ghi entry vào
  workspace `.open-bot/mcp.json`, không bao giờ ghi key/token (trả về
  `nextSteps` hướng dẫn user tự điền); `overrides` chỉ cho `name`/`args`.
  Main nối IPC `mcp-marketplace:*` (install/uninstall làm mất hiệu lực
  runtime để nạp lại tool MCP); preload + renderer types đã có, UI duyệt
  /cài chưa có.
- **Team (bản local)** (`packages/core/src/team/`): file `team.json`
  local, role admin/member/viewer; `canUseBot` (admin/member dùng bot đã
  share), `canEditBot` (admin sửa mọi bot share, member chỉ sửa bot mình
  share); main nối IPC `team:*` và chặn sửa/xoá bot khi team không cho
  phép (chủ máy không nằm trong team thì không bị ràng buộc). Chưa có
  server trung tâm / xác thực thật — đó là việc v0.5.

## v0.3 wave 2 — node-agent-coordinator đã nối vào main (2026-11-08)

- **Coordinator con** (`packages/core/src/coordinator/`): tiến trình con
  chạy `AgentRunner` + sở hữu `BotMemory` (SQLite) cho mọi bot; main
  không bao giờ mở BotMemory để tránh tranh chấp. Nói NDJSON-RPC qua
  stdio (request `{id, method, params}`, response `{id, result|error}`,
  notification `{event, data}`), method: `createBot` / `run` /
  `stopBot` / `listBots` / `destroyBot` / `ping` / `shutdown` /
  `respondApproval` / `respondAskUser` / `saveMessage` / `getHistory` /
  `listTasks`. Registry dựng trong con y hệt main cũ (default + code +
  plan + subagent + MCP = 48 tool); plugin tools nạp trong con qua
  `pluginsDir` (tool là function, không qua được RPC nên con phải tự
  load bằng `PluginManager`). `createBot` trùng id bị từ chối; run đồng
  thời 2 lượt trên cùng bot bị từ chối; lỗi của một bot không giết
  coordinator.
- **Round-trip approval/ask-user:** con emit notification
  `approval-needed` (`{callId, call}` — callId là `ToolCall.id`) rồi
  chờ `respondApproval`; `ask-user` (`{requestId, question, options}`)
  chờ `respondAskUser`. Hết 10 phút không trả lời thì mặc định từ chối
  / `''` (giống timeout cũ của main). `autoApprove` duyệt ngay không
  emit. Từ chối approval dừng cả lượt ngay, runner trả `'đã hủy'`.
- **Main thành proxy mỏng:** `getCoordinator()` (lazy singleton,
  `CoordinatorClient` + `onEvent` chuyển thành IPC renderer);
  `getOrCreateRuntime` / `chat:send` / `chat:history` / `tasks:list`
  đều async qua RPC; `invalidateRuntime` gọi `destroyBot` (best-effort).
  Con chết thì main tự bỏ handle và spawn lại khi cần (lịch sử nằm
  trong file `memory.db` nên bot mới mở lại vẫn thấy).
- **Điểm mấu chốt khi spawn từ Electron:** `process.execPath` ở main là
  binary Electron — phải truyền env `ELECTRON_RUN_AS_NODE=1` thì nó mới
  chạy entry coordinator như Node thuần (đã kiểm chứng ping/pong);
  không có flag này Electron load entry như một Electron app và mọi
  request đều treo. `utilityProcess.fork` KHÔNG dùng được vì nó cấm
  pipe stdin (chỉ `ignore`), mà RPC cần ghi vào stdin của con.
- **Giới hạn đã biết:** `stopBot` abort tới được tool qua `ctx.signal`
  nhưng `provider.chat()` đang chờ mạng không bị huỷ (runner không có
  đường truyền signal tới provider) — run có thể vẫn hoàn tất, chỉ được
  đánh dấu `stopped:true`. API key đi qua stdio cùng máy trong params
  của `createBot` (không log, không listener mạng); key vẫn nằm trong bộ
  nhớ tiến trình con.

## v0.3 wave 2 (tiếp) — local-exec-daemon đã nối vào shell_exec (2026-11-08)

- **Daemon** (`packages/tools/src/daemon/`): tiến trình cháu của Electron
  (main → coordinator → daemon; env `ELECTRON_RUN_AS_NODE=1` kế thừa nên
  cả hai tầng con đều chạy như Node thuần), NDJSON-RPC qua stdio,
  method `exec` / `kill` / `list` / `ping` / `shutdown`. Spawn trực
  tiếp program + args (không qua shell, không có shell-injection);
  stream stdout/stderr; timeout giết bằng SIGKILL; lỗi (lệnh không tồn
  tại, cwd sai, params sai) trả error response, daemon không crash.
  `DaemonClient` (request/response theo id, `dispose` gửi shutdown rồi
  đợi tối đa 5s mới SIGKILL, chết bất ngờ thì reject mọi request đang
  chờ thay vì treo).
- **`shell_exec` chạy qua daemon:** `createShellExecTool(getDaemon)` —
  khi coordinator cấp daemon thì lệnh chạy trong daemon, không thì chạy
  in-process qua `runShell` (fallback). Sandbox check (denylist +
  cwd confinement) LUÔN chạy ở tool trước khi tới daemon (daemon không
  tự check). Env của shell con là `safeEnv()` allowlist THAY THẾ hoàn
  toàn env kế thừa (daemon đổi semantics: `env` được cấp thì thay thế,
  không merge) — shell con không bao giờ thấy secret trong env của
  tiến trình cha. Output hai đường giống hệt nhau (`exit code: N` +
  `--- stdout ---` / `--- stderr ---`). `ctx.signal` abort → kill theo
  execId (client nhận execId do tool cấp).
- **Kill cả process group (bug thật đã bắt khi test):** `sh -c 'sleep 30'`
  — giết chỉ `sh` thì `sleep` (con của sh) vẫn giữ ống stdio nên Node
  `'close'` không fire, exec treo đủ 30s. Đã sửa ở cả daemon và
  `runShell`: spawn `detached` (own process group, non-Windows) và
  SIGKILL cả group (`process.kill(-pid)`). Test abort giờ xong trong
  <1s thay vì 30s. `runShell` cũng bỏ `signal` truyền vào spawn (Node
  chỉ giết con trực tiếp — cùng lỗi) mà tự lắng nghe abort để kill group.
- **Coordinator sở hữu daemon:** 1 daemon/client cho cả coordinator
  con, tạo lazy lúc dùng shell lần đầu (chưa dùng thì chưa chạy —
  `daemonStatus` báo `running:false`), chết thì tự bỏ reference và tạo
  lại ở lần gọi shell sau; `shutdown()` dispose daemon. RPC mới
  `daemonStatus` → `{running, pid}` (chẩn đoán + test). Main không
  đụng tới daemon — nó sống dưới coordinator.
- **Giới hạn đã biết:** daemon không cap số exec song song hay dung
  lượng output stream (chunk chỉ forward, không có backpressure); không
  có sandbox/denylist riêng (lớp gọi chịu trách nhiệm — tool đã check);
  exec không có `timeoutMs` mà treo mãi thì promise treo mãi (timeout do
  `timeoutMs` quyết); chưa test Windows/macOS (code có `windowsHide`,
  group-kill chỉ áp dụng non-Windows).

## Cập nhật kiến trúc v0.4–v0.84 (ghi 2026-11-11 — các mục trên mô tả tới v0.3, cộng ghi chú v0.65)

Những điểm dưới đây đã thay đổi so với mô tả v0.1–v0.3 ở trên; mỗi
khẳng định đều có file code đối chiếu. Các mục trên giữ nguyên như
bản ghi lịch sử của từng mốc — đọc cùng mục này để có ảnh toàn cảnh
hiện tại.

- **Coordinator sở hữu AgentRunner, main là proxy mỏng.** Từ v0.3
  wave 2, `AgentRunner` + `BotMemory` (SQLite) sống trong tiến trình
  coordinator con (`apps/desktop/src/main/main.ts`: "Bot runtime:
  AgentRunner + BotMemory sống trong tiến trình coordinator con",
  "Coordinator child: owns every AgentRunner + BotMemory"). Main
  process không chạy agent loop: `chat:send` và các IPC khác forward
  qua RPC xuống coordinator (`coordinator.stopBot`, `composio.*`,
  `apps.*`…). Câu "Main process … sở hữu `AgentRunner`" ở mục Tổng
  quan và sơ đồ trên đã cũ — thay bằng: main sở hữu cửa sổ/tray/IPC/
  Vault, coordinator sở hữu runtime.
- **API key đã dời sang Vault (v0.4).** `migrateApiKeysToVault()`
  trong `apps/desktop/src/main/main.ts` dời key còn nằm trong
  `settings.json` sang Vault (namespace `provider`) rồi xoá khỏi
  settings; chạy 1 lần, idempotent; sau đó `settings.json` KHÔNG BAO
  GIỜ chứa API key. Bảng "Dữ liệu lưu local" ở trên (API key ở
  `settings.json`, "plaintext cho tới khi có vault ở v0.4") chỉ đúng
  tới v0.3. Xem thêm `docs/SETUP.md` (mục Vault).
- **MCP: connection pool + OAuth đầy đủ.** Pool client MCP từ v0.9
  (`packages/tools/src/mcpTools.ts`: connection pool theo workspace +
  server, tái dùng giữa các lần gọi, idle quá 5 phút thì đóng, vượt
  số client tối đa thì evict LRU). OAuth MCP đầy đủ
  (`packages/core/src/mcp/oauth.ts`: RFC 9728/8414 discovery, RFC
  7591 dynamic client registration, refresh qua
  `getValidAccessToken` với skew 60 giây; token lưu Vault namespace
  `mcp-oauth` theo từng server). OAuth cho connector app (Slack/
  Gmail/Teams/Google…) tự refresh qua `callWithAutoRefresh` với
  ngưỡng 5 phút (`REFRESH_BEFORE_MS`,
  `packages/core/src/connectors/framework.ts`).
- **Daemon: cap 4 exec song song + stream cap 200k.** "Giới hạn đã
  biết" ở cuối mục v0.3 wave 2 ("daemon không cap số exec song song
  hay dung lượng output stream") đã cũ: từ v0.14
  `DEFAULT_DAEMON_MAX_EXECS = 4` (`packages/tools/src/daemon/types.ts`;
  trước đó là 8 + reject), exec vượt cap xếp hàng FIFO thay vì bị
  reject; từ v0.6 `MAX_EXEC_OUTPUT_CHARS = 200_000` ký tự/stream
  (vượt cap thì gửi 1 marker truncation rồi drop phần còn lại).
- **Request ra ngoài máy không còn chỉ là provider AI.** Câu "Request
  mạng duy nhất ra ngoài máy là request tới provider AI" ở mục "Dữ
  liệu lưu local" chỉ đúng ở v0.1. Hiện tại còn có: Composio
  (`https://backend.composio.dev/api/v3.1`, khi user bật Composio —
  xem `docs/composio-integration.md`); update-check (GitHub releases
  repo `hoangthuanreview20-boop/open-bot`,
  `packages/core/src/update/checker.ts`, chỉ khi user bấm kiểm tra);
  MCP server ngoài do user cấu hình (stdio/HTTP qua `connectMcp`);
  web search/fetch (`web_search`/`web_fetch`/`http_get`, qua tool đã
  được phê duyệt); và các connector/app OAuth (Slack, Gmail, Jira…)
  gọi API của nhà cung cấp đó. Mọi request đều đi từ máy user, không
  có backend cloud của open-bot; shell/egress chịu thêm policy
  fail-closed (`docs/egress-policy.md`, từ v0.40).
- **Quy mô hiện tại (đo 2026-11-11):** 137 tool/bot
  (`tests/coordinator.test.mjs` assert `toolCount` 137), 141.257 dòng
  TypeScript nguồn (`wc -l` trên `packages/` + `apps/`, trừ
  `dist/`/`node_modules/`, HEAD v0.84), i18n 1.250 key/file × 6 locale
  (vi/en/zh/ja/es/fr).
