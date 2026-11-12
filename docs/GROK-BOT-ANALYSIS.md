# Phân tích tĩnh — Grok Bot 0.79.3 (Windows x64)

> **Phạm vi:** Chỉ phân tích tĩnh phục vụ việc học kiến trúc để thiết kế dự án
> open-bot. **Không** cài đặt, **không** chạy file exe hay bất kỳ binary nào trích
> ra, **không** sao chép code, text, hình ảnh hay tài sản của xAI/Cursor.
> Mọi nội dung dưới đây là mô tả kiến trúc và hành vi bằng lời của người phân
> tích (tên endpoint, tên tính năng, luồng hoạt động ở mức khái niệm).
>
> Ngày phân tích: 2026-11-08. Người phân tích: subagent (phân tích tĩnh).

## 1. Thông tin file

| Hạng mục | Giá trị |
|---|---|
| File phân tích (bản copy) | `~/tools/grokbot/Grok_Bot_0.79.3_Setup.exe` |
| Bản gốc | `~/workspace/browser_downloads/sess-3804552700/` (cùng tên file) |
| Phiên bản | Grok Bot 0.79.3, Windows x64 |
| Kích thước | 125.407.304 bytes (119,6 MB) |
| SHA-256 đo được | `5dede0efa229dfb7d1b6c251edf4a7a19225df6837bccc7e09d1193de5766846` |
| SHA-256 kỳ vọng | `5dede0efa229dfb7d1b6c251edf4a7a19225df6837bccc7e09d1193de5766846` |
| **Kết quả xác minh hash** | **✅ KHỚP** |
| Loại file (`file`) | PE32 executable (GUI) Intel 80386, for MS Windows, Nullsoft Installer self-extracting archive, 5 sections |
| Định dạng installer | NSIS 3 Unicode (Nullsoft Install System v3.04, `requestedExecutionLevel: asInvoker`) |
| Nhà phát hành (metadata PE) | CompanyName: SpaceXAI; ProductName: Grok Bot; FileDescription: Grok Bot desktop agent; Copyright © 2026 SpaceXAI; FileVersion/ProductVersion: 0.79.3 |
| Chữ ký số | Bảng chứng chỉ PE có dữ liệu (15.656 bytes) → file **có chữ ký số kèm theo**. Chưa xác minh được tên signer/chuỗi chứng chỉ vì máy không có sẵn `osslsigncode`/`pefile` — cần kiểm tra lại trên Windows hoặc cài thêm công cụ nếu cần. |
| Nguồn tải | `https://api2.cursor.sh/updates/download/stable/win32-x64/grok-bot-cf55d121b6d17368` — link chính thức do trang `https://x.ai/bot` công bố, host trên CDN của Cursor |
| Ngày build (trong `package.json`) | `sandBuiltAt: 2026-11-06T23:17:34.364Z`; kênh phát hành `sandTrack: stable` |

## 2. Kết luận kiến trúc

### 2.1. Kết luận ngắn

**Đây là ứng dụng Electron, xây trên nền Cursor (VS Code-derived), không phải
ứng dụng native thuần.**

- **Electron 42.11.16** (kèm Chromium 148.0.7778.280 — đọc từ chuỗi version trong `Grok Bot.exe`).
- Nhân là **Cursor**: `package.json` có `homepage: https://cursor.com`, tên gói
  nội bộ là `sand`, hàng chục package nội bộ `@anysphere/*` (hạ tầng của
  Cursor/Anysphere) và `@sand/*` (lớp riêng của Grok Bot). Nói cách khác:
  Grok Bot = Cursor (editor/agent platform) được đóng gói lại thành một
  "desktop agent" chạy thường trực, chứ không phải một editor.
- **Không cần phân tích PE sâu bằng Ghidra/Rizin**: vì logic ứng dụng nằm
  trong ASAR (JavaScript đã bundle), không nằm trong binary native.

### 2.2. Cấu trúc installer (NSIS, 2 lớp)

```
Grok_Bot_0.79.3_Setup.exe  (NSIS, 125 MB)
└── $PLUGINSDIR/
    ├── app-64.7z            ← toàn bộ ứng dụng, nén LZMA2 (124 MB → 436 MB sau giải nén)
    ├── System.dll, UAC.dll, StdUtils.dll, nsDialogs.dll, nsExec.dll,
    │   nsis7z.dll, WinShell.dll   (plugin NSIS chuẩn)
    └── modern-wizard.bmp
└── $R0/Uninstall Grok Bot.exe
```

Giải nén `app-64.7z` được 118 file, 417 MB — layout Electron chuẩn:

```
app/
├── Grok Bot.exe                  (Electron binary, 235 MB — đã đổi tên, không phải electron.exe)
├── resources/
│   ├── app.asar                  (54 MB — toàn bộ code JS/TS đã build)
│   ├── app.asar.unpacked/dist/   (native modules .node, 1 file .exe xem §2.4)
│   └── elevate.exe               (helper nâng quyền)
├── resources.pak, chrome_100/200_percent.pak, icudtl.dat
├── locales/ (55 file .pak ngôn ngữ, gồm vi.pak)
├── ffmpeg.dll, libEGL.dll, libGLESv2.dll, d3dcompiler_47.dll,
│   dxcompiler.dll, dxil.dll, vk_swiftshader.dll, vulkan-1.dll
├── snapshot_blob.bin, v8_context_snapshot.bin
└── LICENSE.electron.txt, LICENSES.chromium.html
```

### 2.3. Cấu trúc bên trong `app.asar` (đã trích ra `~/tools/grokbot/asar-src/`)

- Tổng cộng **921 file** sau khi trích: 658 file `.js`, 51 file `.cjs`,
  122 ảnh PNG, 22 font WOFF2, 15 JSON, 14 SVG, 9 file `.node`, 1 file `.wasm`,
  1 file `.exe`.
- `package.json` trong ASAR: `name: "sand"`, `productName: "Grok Bot"`,
  `main: "dist/electron-main/main.cjs"`, `type: "module"`, `private: true`.
- Code **đã bundle + minify** (Rolldown; renderer chia ~641 chunk JS,
  chunk lớn nhất ~855 KB). Tên biến/hàm đã rút gọn nên chỉ đọc được
  **kiến trúc, tên dịch vụ, tên message/tool, chuỗi endpoint** — không khôi
  phục được logic chi tiết hay source gốc. Không thấy dấu hiệu mã hoá ASAR
  (trích bằng `asar` chuẩn thành công ngay).

```
dist/
├── electron-main/        (8,6 MB)  main.cjs, main-core.cjs (~1,2 MB),
│                                     main-app.cjs (~3,5 MB), proto.cjs (~1,5 MB),
│                                     onepassword-connection-service.cjs,
│                                     menubar-tray/, locales/
├── electron-preload/     (244 KB)  preload.cjs + 5 preload chuyên biệt
│                                     (avatar, VNC, webview, desktop-mount…)
├── local-exec-daemon/    (4,0 MB)  main.cjs, messages-worker.cjs
├── node-agent-coordinator/ (1,3 MB) main.cjs
├── renderer/             (42 MB)   index.html + assets/ (React app)
├── native/               sand-webauthn-signer.exe
└── deps/                 (4,6 MB)  native modules .node + manifest
```

### 2.4. Mô hình tiến trình (process model)

- **Main process 2 giai đoạn**: `main.cjs` (entry, rất nhỏ) nạp `main-core.cjs`
  trước, rồi mới nạp `main-app.cjs` sau khi core báo sẵn sàng; có cơ chế
  V8 code-cache (giữ 2 bản cache mới nhất, dọn bản cũ sau 1 giờ) để tăng
  tốc khởi động. Entry còn chứa logic **"deployment pinning"**: trên
  Windows đọc giá trị policy `DeploymentBackendUrl` / `DeploymentWebsiteUrl`
  (tương tự trên macOS qua user defaults, Linux qua `~/.cursor/policy.json`)
  để ghim backend/website của một triển khai được quản lý — tức app hỗ trợ
  chạy trong môi trường doanh nghiệp với backend riêng.
- **Renderer process**: React app (`dist/renderer/`, `index.html`, CSP khá
  chặt: `script-src 'self'`, `connect-src` chỉ cho phép `https://grok.com`
  cùng `ws:`/`sand-media:`; có các custom scheme `sand-*` cho avatar,
  favicon, media, HTML preview, canvas, MCP app).
- **2 tiến trình phụ tách riêng**:
  - `local-exec-daemon` — daemon thực thi lệnh local (chạy shell/lệnh trên máy).
  - `node-agent-coordinator` — điều phối các agent con (Node).
- **Native modules** (9 file `.node`, xem `dist/deps/runtime-deps-manifest.json`):
  chụp cửa sổ (`sand-window-capture`), nhận diện thiết bị (`sand-devicecheck`),
  tra cứu địa chỉ (`sand-address-lookup`), nhận dạng text trên thẻ
  (`sand-card-text-recognition`), cài đặt thông báo (`sand-notification-settings`),
  liệt kê process (`cursor-proclist`), xử lý JPEG (`@anysphere/jpeg-napi`),
  phân tích cú pháp code (`tree-sitter`, `tree-sitter-bash` + `web-tree-sitter`).
- **Helper binary**: `elevate.exe` (nâng quyền khi cần), `sand-webauthn-signer.exe`
  (ký WebAuthn — phục vụ đăng nhập/xác thực phần cứng).

### 2.5. Thư viện/dependency đáng chú ý (từ `package.json`)

- Giao tiếp backend: **ConnectRPC** (`@connectrpc/connect`, `@connectrpc/connect-node`)
  + **Protobuf** (`@bufbuild/protobuf`) — API dùng RPC nhị phân kiểu gRPC,
  không phải REST JSON thông thường.
- Telemetry: **OpenTelemetry**, **Sentry** (`@sentry/electron`/`@sentry/node-core`),
  **Statsig** (feature flag / experiment).
- UI: React, Tiptap (editor), StyleX, TanStack Query, Lingui (i18n).
- Xử lý tài liệu: `pdfjs-dist`, `mammoth` (docx), `xlsx`, `katex`.
- Khác: `ws` (WebSocket), `qrcode`, `adm-zip`, `zod`, Playwright runtime
  (`@anysphere/sand-playwright-runtime` — điều khiển trình duyệt).
- Gần như toàn bộ package `@anysphere/*` và `@sand/*` là `workspace:*`
  (nội bộ monorepo, không công khai trên npm) — không thể tham khảo source.

## 3. Endpoint API phát hiện được

Tổng cộng **~16 endpoint/host đáng chú ý** (tên host + vai trò suy ra từ ngữ
cảnh chuỗi xuất hiện; chỉ liệt kê endpoint, không sao chép code gọi API).
Số file là số file trong ASAR chứa chuỗi đó.

| # | Endpoint / host | Vai trò (suy luận từ ngữ cảnh) | File nguồn |
|---|---|---|---|
| 1 | `https://api2.cursor.sh` | **Backend chính** của app (mặc định; có thể override bằng biến môi trường `CURSOR_API_BASE_URL`). Mọi service RPC (Dashboard, AI, GrokBot…) đều gọi về đây | `dist/electron-main/main-app.cjs`, `main-core.cjs`, `preload.cjs`, `dist/local-exec-daemon/main.cjs`, `dist/node-agent-coordinator/main.cjs` |
| 2 | `https://api2.cursor.sh/updates` | **Auto-update** (kiểm tra/tải bản mới; khớp với link tải installer) | `dist/electron-main/main-core.cjs` |
| 3 | `https://api.origin.cursor.com` | Backend origin dự phòng / song song với api2 | `dist/electron-main/main-core.cjs`, `dist/local-exec-daemon/main.cjs` |
| 4 | `https://api3.cursor.sh/tev1/v1` | **Statsig** — feature flag / thử nghiệm / cấu hình từ xa (kèm client key riêng của app) | `dist/electron-main/main-app.cjs` |
| 5 | `https://authenticator.cursor.sh` | Dịch vụ xác thực (authenticator) của Cursor | `dist/electron-main/main-app.cjs` |
| 6 | `https://prod.authentication.cursor.sh` | Dịch vụ xác thực production của Cursor | `dist/electron-main/main-app.cjs` |
| 7 | `https://downloads.cursor.com` | Host tải file (download) | `dist/electron-main/main-app.cjs` |
| 8 | `wss://api.x.ai/` | **Realtime voice-call** — endpoint WebSocket duy nhất của xAI trong client; code kiểm tra URL có bắt đầu bằng origin này mới cho phép "dial" (gọi) | `dist/electron-main/main-app.cjs`, `dist/renderer/assets/index.eager-app-*.js` |
| 9 | `https://api.x.ai` (+ path `/auth/exchange_user_api_key`) | API xAI; có một luồng đổi token lấy "user API key" qua path trên | `dist/electron-main/main-app.cjs` |
| 10 | `https://metrics.cursor.sh/…` | Thu thập chỉ số / endpoint báo lỗi (Sentry DSN host) | `dist/electron-main/main-core.cjs`, `dist/local-exec-daemon/main.cjs`, renderer |
| 11 | `https://cursor.com/grok-bot/link/v1/` (và `/finance`) | Deep-link/liên kết tài khoản, trang liên kết Grok Bot | `dist/electron-main/main-app.cjs` |
| 12 | `https://grok.com/connectors-oauth-exchange-code/` | Đổi authorization code lấy token cho **connector** (tích hợp bên thứ ba) | `dist/electron-main/main-app.cjs` |
| 13 | `https://x.com/i/connectors/oauth_callback`, `https://chat.x.com/connectors/oauth_callback`, `https://lite.x.com/connectors/oauth_callback` | OAuth callback cho connector qua X / chat.x.com / lite.x.com | `dist/electron-main/main-app.cjs` |
| 14 | `https://www.cursor.com/agents/mcp/oauth/callback` | OAuth callback cho MCP server | `dist/electron-main/main-app.cjs` |
| 15 | `https://docs.x.ai/grok-bot`, `https://cursor.com/en-US/terms/grok-bot` | Tài liệu và điều khoản (không phải API) | `dist/electron-main/main-app.cjs`, renderer |
| 16 | Local/dev | `http://localhost:4000` (backend dev), `http://localhost:8787/callback` (OAuth callback local), custom protocol `grokbot://mcp/oauth/callback` và `cursor://anysphere.cursor-mcp/oauth/return` | `dist/electron-main/main-core.cjs`, `main-app.cjs` |

Nhận xét:

- **Hầu hết logic nghiệp vụ không đi qua REST công khai mà qua RPC nhị phân**
  (ConnectRPC/Protobuf) tới `api2.cursor.sh`: các service định nghĩa trong
  `proto.cjs` gồm `DashboardService`, `AiService`, `GrokBotService`,
  `AgentStoreService`, `BackgroundComposerService`, `AnalyticsService`,
  `SandBoxService` (xem §5). Không thấy document OpenAPI/spec công khai nào
  trong app.
- **xAI chỉ xuất hiện trực tiếp ở 2 chỗ**: realtime voice (`wss://api.x.ai/`)
  và luồng đổi API key (`/auth/exchange_user_api_key`). Suy luận: phần lớn
  inference/agent chạy qua hạ tầng Cursor rồi mới gọi sang xAI phía server,
  chứ client desktop không gọi thẳng API Grok.
- Trong code còn có sẵn một số **client key nhúng** (Statsig client key,
  Sentry DSN). Đây là key công khai phía client của app gốc — **không ghi
  giá trị ra đây và tuyệt đối không dùng lại trong open-bot**; open-bot phải
  dùng key/telemetry của riêng mình.
- CSP của renderer chỉ cho phép `connect-src` tới `https://grok.com`
  (cùng `ws:` và self) — nhất quán với việc client web chỉ nói chuyện với
  grok.com/xAI qua trình duyệt, còn dữ liệu app đi qua backend Cursor.

## 4. Luồng đăng nhập / xác thực (mô tả khái niệm)

- **Hai hệ xác thực song song**: `SandCursorAuthService` (tài khoản Cursor)
  và `SandXaiIdentityAuthService` (định danh xAI). App dùng tài khoản Cursor
  làm danh tính chính; xAI identity phục vụ các tính năng gắn với xAI/Grok.
- **Token**: client giữ một **access token** (chuỗi bearer) kèm
  **machineId** (định danh máy) và **teamId** (định danh team/workspace, nếu có).
  Từ access token, client tự suy ra "account scope" (phạm vi tài khoản) để
  biết token thuộc tài khoản/team nào, và tự kiểm tra tính nhất quán
  (token ↔ teamId) trước khi dùng.
- **Truyền token**: mọi request RPC gắn header `Authorization: Bearer <token>`
  và, khi có team, thêm header team (`x-cursor-team-id`). Có một tầng
  "backend client" tập trung việc này (tự refresh/lấy token, machineId,
  teamId trước mỗi lần gọi).
- **Lưu token**: có sử dụng **Electron `safeStorage`** (mã hoá bằng khoá của
  hệ điều hành — DPAPI trên Windows) để mã hoá rồi lưu dưới dạng base64;
  đoạn code liên quan gắn với file `gateway-descriptor.json`. Ngoài ra còn
  có file `mcp-auth.json` riêng cho credential OAuth của MCP server. Có chế
  độ riêng tư `PrivacyMode.NO_STORAGE` — khi bật, token không được lưu bền.
  (Chi tiết file nào lưu access token chính không xác định chắc chắn từ
  phân tích tĩnh; chỉ khẳng định được cơ chế mã hoá bằng safeStorage.)
- **Đăng nhập**: luồng OAuth qua trình duyệt/callback — custom protocol
  `grokbot://mcp/oauth/callback`, `cursor://…/oauth/return` và
  `http://localhost:8787/callback`; connector dùng OAuth với scope
  `grok-plugins:access` + `offline_access` (xin refresh token) qua các
  callback của X/grok.com (§3, #12–14).
- **Đổi API key**: có một bước gọi tới path `/auth/exchange_user_api_key`
  để đổi token phiên thành "user API key" (dùng cho các tích hợp cần key).
- **Cấu hình triển khai**: app có thể bị "ghim" backend/website qua policy
  của máy (Windows registry / `~/.cursor/policy.json` / macOS defaults)
  — môi trường doanh nghiệp tự host backend riêng.
- **Lưu ý bảo mật cho open-bot**: không bao giờ log token (code gốc có hàm
  lọc chuỗi `Bearer …` thành `<redacted>`), và tách token phiên / OAuth
  refresh token / API key thành 3 loại credential khác nhau.

## 5. Tool / capability của agent Grok Bot

### 5.1. Tổng quan

Định nghĩa tool nằm trong `dist/electron-main/proto.cjs`: **76 kiểu
`*ToolCall`** (mỗi kiểu là một lời gọi tool mà agent có thể thực hiện, kèm
kiểu tham số/kết quả/lỗi). Ngoài ra còn có các RPC quản lý agent
(`GrokBotService`: tạo/sửa/xoá/nhân bản/publish agent, quản lý template,
marketplace, chia sẻ, session, meeting, email, Slack… — riêng phần admin
đã có hàng trăm message, xem §5.3). Dưới đây là 76 tool đã gom nhóm theo
chức năng (chỉ liệt kê tên + vai trò khái niệm).

### 5.2. Danh sách tool (76 kiểu, gom nhóm)

> Đính chính v0.37 (REA deep-dive lần 2, `docs/rea-grokbot-deep-dive.md` §3.2): vẫn 76 kiểu nhưng khác 1 kiểu so với bản liệt kê trước — thiếu `ReplaceEnvToolCall` (đã thêm ở bảng "Khác"), thừa `ExecuteSandMcpTool` (đó là executor chạy MCP, không phải `*ToolCall` — đã gỡ khỏi bảng MCP).

**File & code (đọc/ghi/tìm kiếm mã nguồn)**

| Tool | Vai trò khái niệm |
|---|---|
| `ReadToolCall` | Đọc nội dung file |
| `EditToolCall` | Sửa file theo diff/chỉ định |
| `DeleteToolCall` | Xoá file |
| `GlobToolCall` | Tìm file theo pattern |
| `GrepToolCall` | Tìm kiếm nội dung trong code |
| `SemSearchToolCall` | Tìm kiếm ngữ nghĩa trong codebase |
| `LsToolCall` | Liệt kê thư mục |
| `ApplyAgentDiffToolCall` | Áp dụng bản diff do agent tạo |
| `BlameByFilePathToolCall` | Xem lịch sử/blame theo file |
| `ReadLintsToolCall` | Đọc lỗi lint/chẩn đoán |
| `ConversationHistoryToolCall` | Đọc lại lịch sử hội thoại |
| `FetchCloudAgentDataToolCall` | Lấy dữ liệu của cloud agent |

**Shell / thực thi trên máy**

| Tool | Vai trò khái niệm |
|---|---|
| `ShellToolCall` | Chạy lệnh shell |
| `ExecuteToolCall` | Thực thi lệnh/tác vụ |
| `WriteShellStdinToolCall` | Ghi vào stdin của shell đang chạy |
| `SetupVmEnvironmentToolCall` | Chuẩn bị môi trường máy ảo/sandbox cho agent |
| `GrokBotUserComputerLocalToolCall` | Tool local trên máy người dùng (nhóm computer-local) |

**Computer-use (điều khiển máy tính như người dùng)**

| Tool | Vai trò khái niệm |
|---|---|
| `ComputerUseToolCall` | Điều khiển máy tính (chuột/bàn phím/màn hình) |
| `RecordScreenToolCall` | Ghi/quay màn hình |
| (hỗ trợ) | Native `sand-window-capture` + `sand-devicecheck` (§2.4); renderer có chunk `computer-screen-preview` |

**Web**

| Tool | Vai trò khái niệm |
|---|---|
| `WebSearchToolCall` | Tìm kiếm web |
| `XSearchToolCall` | Tìm kiếm trên X |
| `WebFetchToolCall` | Tải/đọc nội dung URL |
| `FetchToolCall` | Fetch tài nguyên web chung |

**Tạo sinh media & canvas**

| Tool | Vai trò khái niệm |
|---|---|
| `GenerateImageToolCall` | Sinh ảnh |
| `GenerateVideoToolCall` | Sinh video |
| `ReadCanvasToolCall` / `WriteCanvasToolCall` | Đọc/ghi "canvas" (bảng vẽ/tài liệu tương tác trong app) |

**Quản lý dự án / kế hoạch / task**

| Tool | Vai trò khái niệm |
|---|---|
| `CreatePlanToolCall` | Lập kế hoạch |
| `CreateTrackedTasksToolCall`, `UpdateTrackedTasksToolCall`, `DeleteTrackedTasksToolCall`, `ListTrackedTasksToolCall`, `UpdateTrackedTaskStatusesToolCall`, `UpdateTrackedTaskTagsToolCall` | CRUD + theo dõi trạng thái/tag của task |
| `CreateGoalToolCall`, `UpdateGoalToolCall` | Quản lý goal/mục tiêu |
| `ReadTodosToolCall`, `UpdateTodosToolCall` | Danh sách việc cần làm |
| `CreateProjectToolCall` | Tạo project |
| `StartProjectUpdatesToolCall`, `StopProjectUpdatesToolCall` | Bật/tắt cập nhật định kỳ về project |
| `StartGrindExecutionToolCall`, `StartGrindPlanningToolCall` | Chế độ "grind" — lập kế hoạch rồi thực thi dài hơi |

**Agent-to-agent & điều phối**

| Tool | Vai trò khái niệm |
|---|---|
| `TaskToolCall` | Giao việc cho agent con (subagent) |
| `CreateAgentToolCall` | Tạo agent mới |
| `SendToAgentToolCall` | Gửi message cho agent khác |
| `GetAgentStatusToolCall` | Kiểm tra trạng thái agent |
| `StopAgentToolCall` | Dừng agent |
| `SendMessageToolCall`, `SendToUserToolCall`, `SendFinalSummaryToolCall`, `CommunicateUpdateToolCall`, `AskQuestionToolCall` | Nhắn tin / hỏi người dùng / gửi tóm tắt cuối |
| `SwitchModeToolCall` | Đổi chế độ làm việc của agent |
| `ReflectToolCall`, `AwaitToolCall` | Tự phản tư / chờ |
| `SearchConversationsToolCall` | Tìm trong các hội thoại khác |
| `ReadAgentTranscriptToolCall` | Đọc transcript của agent khác |

**MCP & tích hợp ngoài**

| Tool | Vai trò khái niệm |
|---|---|
| `McpToolCall`, `GetMcpToolsToolCall`, `ListMcpResourcesToolCall`, `ReadMcpResourceToolCall`, `McpAuthToolCall` | Gọi tool/resource của MCP server, xác thực MCP |
| `ConnectScmToolCall` | Kết nối hệ quản lý source (git host) |
| `PrManagementToolCall`, `GetPrCodeTourToolCall`, `UpdatePrCodeTourToolCall`, `EditPrLabelsToolCall`, `SetActiveBranchToolCall` | Quản lý pull request / code tour / branch |

**Khác**

| Tool | Vai trò khái niệm |
|---|---|
| `ManageAccessToolCall` | Quản lý quyền truy cập agent |
| `ReplaceEnvToolCall` | Đổi biến môi trường của session box đang chạy (kèm `associated_pod_key`) |
| `RecordCiInvestigationFindingsToolCall`, `ReportBugToolCall`, `ReportBugfixResultsToolCall` | Điều tra lỗi CI / báo bug / báo cáo kết quả sửa |
| `AiAttributionToolCall` | Ghi nhận nguồn/attribution của AI |
| `TruncatedToolCall` | Đánh dấu tool call bị cắt ngắn (cơ chế giới hạn độ dài) |

### 5.3. Capability ngoài bộ tool (từ RPC service + UI)

- **Agent dạng "team bot"**: tạo/nhân bản/publish agent, template, marketplace
  listing, chia sẻ + phân quyền (invite, access grant), quản lý theo team,
  "service account" (agent chạy với tài khoản dịch vụ), "session box"
  (phiên chạy trong hộp cát phía server — xem `SandBoxService`).
- **Tích hợp nhắn tin/email**: Slack (rất sâu: Slack app, workspace link,
  dialog live), email (inbox/thread, gửi/nhận, suppression, dead-letter
  queue), Microsoft Teams (connect/link account), iMessage (draft sender),
  meeting (join consent, transcript, summary, avatar link).
- **Skills/plugins/connectors**: marketplace + plugin file, custom MCP
  (per-agent và per-team), "vault" (kho secret: login dialogs, secret slot,
  1Password — có `onepassword-connection-service.cjs` riêng), "canvas
  connector action".
- **Voice**: voice call (realtime qua `wss://api.x.ai/`), voice memo.
- **Bộ nhớ**: team context summary, memories list, transcript lưu trữ
  (`AgentStoreService`, `AgentTranscript`).
- **Tự động hoá**: agent automations, routines, scheduled tasks (cron-like),
  "dream" (tác vụ nền — tên message `AdminStartGrokBotDream`).
- **Thanh toán/usage**: usage banner, `xai-commerce-prepaid` (trả trước),
  spend limit.

## 6. Model mặc định và cấu hình liên quan

- **Model mặc định trong client: `grok-4.5`** — hằng số `SAND_DEFAULT_MODEL_ID`
  trong `dist/electron-main/main-core.cjs` (biến nội bộ trỏ tới chuỗi
  `grok-4.5`). Đây là model client dùng khi không có lựa chọn khác.
- **Model liên quan**: `grok-4.6` xuất hiện cùng `grok-4.5` trong cấu hình
  thử nghiệm Statsig (`effort_first_compact_model_ids: ["grok-4.5", "grok-4.6"]`).
  **Không thấy chuỗi `grok-4.7`** trong ASAR — model mới hơn (nếu có) nhiều
  khả năng do server quyết định hoặc nằm trong cấu hình tải về lúc chạy.
- **Cấu hình model là cấu hình động, không hard-code hoàn toàn**:
  - Statsig flag `sand_default_model` (fallback `modelId: "default"`,
    `maxMode: false`, `parameters: []`) và `sand_automations_model` (model
    riêng cho automations).
  - Proto có `AvailableModelsResponse.FeatureModelConfig` với
    `default_model`, `fallback_models`, `best_of_n_default_models` — tức
    **server trả về danh sách model khả dụng + model mặc định + model dự
    phòng theo từng tính năng**; client chỉ lưu lựa chọn người dùng
    (`default_model_selection` trong user settings).
  - Có flag thử nghiệm `promote_first_party_variant` / `effort_first_variant`
    (control / `grok_primary`…) — server có thể điều phối model theo
    experiment.
- **Kết luận cho open-bot**: đừng hard-code tên model; thiết kế "model
  registry" phía server (default + fallback + per-feature) và client chỉ lưu
  lựa chọn + nhận cấu hình từ xa.

## 7. Những điểm áp dụng được cho open-bot

- **Chia 3 tầng tiến trình**: main (điều phối) + renderer (UI) + daemon thực
  thi local + coordinator cho agent con. Tách daemon thực thi ra khỏi UI
  giúp agent chạy lệnh dài mà không treo giao diện; crash daemon không kéo
  sập app.
- **Boot 2 giai đoạn + V8 code-cache**: core nhẹ khởi động trước, app nặng
  nạp sau; cache bytecode để lần mở sau nhanh hơn.
- **Backend = RPC có schema (ConnectRPC/Protobuf) thay vì REST tự do**:
  định nghĩa service/message rõ ràng (`Dashboard`, `AI`, `GrokBot`,
  `AgentStore`, `Sandbox`…), version hoá bằng proto, client sinh code từ
  schema. Open-bot nên bắt đầu bằng một file proto/schema duy nhất cho
  agent service.
- **Token + scope + team**: một access token đi kèm machineId/teamId; mọi
  request gắn `Authorization: Bearer` + header team; suy ra "account scope"
  từ token để kiểm tra nhất quán trước khi gọi. Lưu token bằng kho mã hoá
  của OS (Electron `safeStorage`/DPAPI/keychain), không lưu plaintext; có
  chế độ `NO_STORAGE`.
- **Tool = kiểu dữ liệu có schema**: mỗi tool là một `*ToolCall` với
  Args/Result/Error riêng (thấy rõ trong proto). Thiết kế tool registry của
  open-bot theo hướng này: mỗi tool khai báo input/output schema, quyền
  (read-only/read-write), và có tool `Truncated`-style để xử lý output quá dài.
- **Nhóm tool tối thiểu nên có trước** (theo mức độ xuất hiện): file
  (read/edit/glob/grep/ls), shell (shell/execute + stdin), web
  (search/fetch), task/plan/todo, nhắn người dùng (ask question / final
  summary), agent con (task/send-to-agent). Computer-use, MCP, media-gen
  để giai đoạn sau.
- **Sandbox 2 lớp**: sandbox local (daemon + quyền workspace
  read-only/read-write) và "session box" phía server. Mọi tool ghi file/chạy
  shell nên đi qua một lớp phân quyền workspace rõ ràng.
- **Model cấu hình từ xa**: default model + fallback + per-feature model do
  server trả về; client chỉ cache lựa chọn. Dùng feature flag (kiểu Statsig)
  để bật/tắt tính năng và thử nghiệm model mà không phát hành bản mới.
- **MCP là cổng mở rộng chính**: thay vì tích hợp cứng từng dịch vụ, app
  chuẩn hoá MCP (tool/resource/auth/callback qua custom protocol
  `grokbot://` + `localhost:8787/callback`). Open-bot nên hỗ trợ MCP client
  ngay từ đầu.
- **Vault/secret tách riêng**: credential của connector/MCP lưu trong kho
  riêng (`mcp-auth.json`, vault, 1Password), không trộn vào cấu hình app
  hay chat history.
- **Telemetry có trách nhiệm**: Sentry/OTel/Statsig tách khỏi dữ liệu chat;
  log phải redact `Authorization: Bearer …`.
- **Update qua kênh riêng**: endpoint `/updates` + track `stable`; giữ cơ
  chế tự cập nhật ngay từ đầu để vá lỗi bảo mật cho agent chạy local.
- **Deployment pinning**: cho phép doanh nghiệp ghim backend qua policy của
  máy — hữu ích nếu open-bot nhắm tới team, không chỉ cá nhân.

## 8. Giới hạn của phân tích

- **Chỉ phân tích tĩnh, không chạy app**: mọi luồng chạy (đăng nhập thật,
  gọi API thật, agent thực thi task) đều là suy luận từ chuỗi/tên symbol —
  có thể sai hoặc thiếu; chưa xác minh bằng hành vi thực tế.
- **Code đã bundle + minify**: tên biến/hàm nội bộ bị rút gọn; chỉ đọc được
  tên service/message/tool và chuỗi literal. Logic chi tiết (prompt hệ
  thống, thứ tự gọi tool, chính sách retry, giới hạn token) **không xem
  được**.
- **Logic phía server không có trong installer**: model routing thực tế,
  danh sách model đầy đủ (ví dụ `grok-4.7` không xuất hiện — có thể do
  server cấp), quota/giá, kiểm duyệt, và phần lớn nghiệp vụ agent
  (GrokBotService) đều nằm ở `api2.cursor.sh`, không có trong client.
- **Không có spec API công khai**: các service là Protobuf nội bộ; muốn gọi
  được phải tự suy ra schema từ `proto.cjs` (chỉ có tên field + kiểu thô)
  hoặc quan sát traffic lúc chạy — cả hai đều ngoài phạm vi phân tích này.
- **Chữ ký số chưa xác minh signer**: chỉ biết PE có bảng chứng chỉ
  (15.656 bytes); chưa đối chiếu chuỗi chứng chỉ/timestamp.
- **Không kiểm tra lỗ hổng bảo mật**: không đánh giá mức độ an toàn của
  sandbox, computer-use hay cơ chế lưu token ngoài mô tả khái niệm ở trên.
- **Phiên bản duy nhất**: kết quả chỉ đúng cho Grok Bot 0.79.3 (build
  2026-11-06); bản mới hơn có thể đổi endpoint/model/tool.

## 9. Phụ lục — đường dẫn làm việc

- Installer (bản copy): `~/tools/grokbot/Grok_Bot_0.79.3_Setup.exe`
- Giải nén NSIS: `~/tools/grokbot/extracted/` (app trong
  `~/tools/grokbot/extracted/app/`)
- ASAR đã trích: `~/tools/grokbot/asar-src/` (921 file, 60 MB)
- File nguồn chính khi cần đối chiếu: `asar-src/package.json`,
  `asar-src/dist/electron-main/main.cjs` (entry),
  `asar-src/dist/electron-main/main-core.cjs`,
  `asar-src/dist/electron-main/main-app.cjs`,
  `asar-src/dist/electron-main/proto.cjs` (định nghĩa service/tool),
  `asar-src/dist/renderer/index.html` (CSP + entry renderer).
